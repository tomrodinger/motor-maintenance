# Motor Maintenance

Browser-based maintenance tool for Gearotons M17 servomotors. Detect every motor
on an RS485 bus, read its firmware and health, assign aliases, run an alive test,
and flash firmware pulled straight from the
[servomotor](https://github.com/tomrodinger/servomotor) repository.

Everything runs in the browser over the Web Serial API — no install, no backend.

## Requirements

Chrome, Edge or Opera **on desktop**. Web Serial is not available in Safari or on
iOS/Android, so phones can only use the built-in demo.

## Try it without hardware

Open the site and choose *"explore with three simulated motors"*. The simulator
speaks the real wire protocol — every byte in the bus console is genuine, and
firmware is really downloaded and really written page by page. Only the motors
are fake.
