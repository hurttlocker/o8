import { reservePiTestRequest } from '../../src/lib/pi/sdk/test-budget';
try {
  reservePiTestRequest(process.argv[2], JSON.parse(process.argv[3]));
  process.stdout.write('reserved\n');
} catch { process.stdout.write('denied\n'); }
