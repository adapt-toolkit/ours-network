#!/bin/sh
node /opt/ours/node_modules/@ours.network/cowork/dist/cli.js --json status |
  node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      try {
        const status = JSON.parse(input);
        process.exit(status.ok === true && status.result?.running === true ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
