"""Owned PTY plus a minimal Kitty graphics emulator; never opens an app window.

The decoder consumes inline RGBA images, validates dimensions, and answers the
presenter's fence only after decompression. It measures no terminal GPU surface.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import termios
import threading
import time
import urllib.request
import zlib

result_path = Path(sys.argv[1]).resolve()
ready = result_path.with_suffix('.ready')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 150, 1200, 816))
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in range(3):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.environ.update(GPUIX_TERMINAL='1', TERM='xterm-kitty', BENCH_READY_FILE=str(ready))
    os.execv(os.environ['BENCH_NODE'], [os.environ['BENCH_NODE'], 'dist/native.mjs'])
os.close(slave)
def terminate(_signum, _frame):
    raise SystemExit('Owned terminal benchmark terminated')
signal.signal(signal.SIGTERM, terminate)
frames = []
errors = []
stop = threading.Event()
clock = lambda: time.monotonic_ns() / 1e6

def read_frames():
    buffer = b''
    chunks = bytearray()
    dimensions = None
    frame_started = None
    try:
        while not stop.is_set():
            if not select.select([master], [], [], .05)[0]:
                continue
            data = os.read(master, 65536)
            if not data:
                break
            buffer += data
            # Pixel mouse query. Size comes from the PTY's winsize ioctl.
            if b'\x1b[?1016$p' in buffer:
                os.write(master, b'\x1b[?1016;1$y')
                buffer = buffer.replace(b'\x1b[?1016$p', b'')
            while b'\x1b_G' in buffer:
                start = buffer.index(b'\x1b_G')
                end = buffer.find(b'\x1b\\', start)
                if end < 0:
                    buffer = buffer[start:]
                    break
                command = buffer[start + 3:end]
                buffer = buffer[end + 2:]
                header, payload = command.split(b';', 1)
                fields = dict(part.split(b'=', 1) for part in header.split(b','))
                if fields.get(b'a') == b'q':
                    # Refuse shared-memory probe, select actual inline transport.
                    answer = b'ENOENT' if fields.get(b't') == b's' else b'OK'
                    os.write(master, b'\x1b_Gi=' + fields[b'i'] + b';' + answer + b'\x1b\\')
                    continue
                if fields.get(b'a') == b'T':
                    chunks.clear()
                    dimensions = (int(fields[b's']), int(fields[b'v']))
                    frame_started = clock()
                if dimensions is not None and payload:
                    chunks.extend(payload)
                    if fields.get(b'm', b'0') == b'0':
                        decode_start = clock()
                        pixels = zlib.decompress(base64.b64decode(chunks))
                        width, height = dimensions
                        if (width, height) != (1200, 816) or len(pixels) != width * height * 4:
                            raise ValueError('Terminal frame size mismatch')
                        marker_offset = ((height - 8) * width + width - 8) * 4
                        marker = list(pixels[marker_offset:marker_offset + 3])
                        frames.append({'atMs': clock(), 'markerRGB': marker, 'decodeMs': clock() - decode_start,
                                       'receiveMs': clock() - frame_started,
                                       'hash': hashlib.sha256(pixels).hexdigest()})
                        dimensions = None
            if len(buffer) > 1000000:
                raise ValueError('Unparsed PTY output exceeds limit')
    except OSError:
        if not stop.is_set():
            errors.append('PTY closed unexpectedly')
    except Exception as error:
        errors.append(str(error))

thread = threading.Thread(target=read_frames, daemon=True)
thread.start()

def wait_for(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if errors:
            raise RuntimeError(errors)
        value = check()
        if value:
            return value
        time.sleep(.001)
    raise TimeoutError('Owned terminal benchmark acknowledgement timed out')

try:
    wait_for(lambda: ready.exists())
    port = json.loads(ready.read_text())['port']
    def command(action, n=None):
        request = urllib.request.Request(f'http://127.0.0.1:{port}', data=json.dumps({'action': action, 'n': n}).encode())
        try:
            return json.load(urllib.request.urlopen(request, timeout=5))['result']
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
    wait_for(lambda: len(frames))
    state = command('state')
    command('focus')
    def measure(action, n=None):
        previous = len(frames)
        start = clock()
        if action == 'key':
            old_input = command('state')['input']
            os.write(master, b'w')
            def acknowledged():
                state = command('state')
                return state['input'] == old_input + 'w' and state['paintedInput']
            wait_for(acknowledged)
            marker = [255, 0, 255] if (len(old_input) + 1) % 2 else [0, 255, 0]
            wait_for(lambda: len(frames) > previous and frames[-1]['markerRGB'] == marker)
            app = {'elapsedMs': clock() - start}
        else:
            app = command(action, n)
        wait_for(lambda: len(frames) > previous)
        frame = frames[-1]
        return {'elapsedMs': frame['atMs'] - start, 'costMs': frame['atMs'] - start,
                'appFrameMs': app['elapsedMs'], 'drawMs': app.get('drawMs'),
                'decodeMs': frame['decodeMs'], 'receiveMs': frame['receiveMs'], 'hash': frame['hash'], 'markerRGB': frame['markerRGB']}
    measure('scroll', 1999)
    stream, keys, scroll = [], [], []
    started = clock()
    for n in range(1, 81):
        time.sleep(max(0, (started + n * 20 - clock()) / 1000))
        stream.append(measure('stream', n))
        if n % 4 == 0:
            keys.append(measure('key'))
    stream_ms = clock() - started
    for n in range(0, 2000, 20):
        scroll.append(measure('scroll', min(n + 19, 1999)))
    final = command('state')
    assert final['input'] == 'w' * 20 and final['tokens'] == 80
    result_path.write_text(json.dumps({'surface': 'terminal', 'fixtureHash': state['fixtureHash'],
        'rows': 2000, 'width': 1200, 'height': 816, 'stream': stream, 'keys': keys, 'scroll': scroll,
        'tokens': 80, 'inputAcknowledged': len(final['input']), 'streamMs': stream_ms,
        'tokensPerSecond': 80 / (stream_ms / 1000), 'decodedFrames': len(frames),
        'measurement': 'Owned PTY inline Kitty RGBA decode completion; HTTP command overhead included; no terminal compositor'}, indent=2))
finally:
    stop.set()
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    os.close(master)
    thread.join(timeout=1)
    ready.unlink(missing_ok=True)
