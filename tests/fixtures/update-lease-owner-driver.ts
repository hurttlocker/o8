import { reserveWorkLaunch, listWorkLaunches } from '../../src/lib/app-update/work-launch-admission';
import { createInterface } from 'node:readline';

if (process.argv[2] === 'inspect') {
  console.log(JSON.stringify({ leases: listWorkLaunches() }));
} else {
  const lease = reserveWorkLaunch('Lease clock fixture');
  if (process.argv[2] === 'bound') lease.started(process.pid);
  const realNow = Date.now;
  const realMonotonic = process.hrtime.bigint;
  const reader = createInterface({ input: process.stdin });
  console.log(JSON.stringify({ ready: true, pid: process.pid }));
  reader.on('line', command => {
    try {
      if (command === 'jump') { Date.now = () => realNow() + 60_000; console.log(JSON.stringify({ leases: listWorkLaunches() })); }
      else if (command === 'advance') { process.hrtime.bigint = () => realMonotonic() + BigInt(31_000_000_000); console.log(JSON.stringify({ leases: listWorkLaunches() })); }
      else if (command === 'bind') { lease.started(process.pid); console.log(JSON.stringify({ bound: true })); }
      else if (command === 'stop') { lease.release(); reader.close(); }
    } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
  });

}
