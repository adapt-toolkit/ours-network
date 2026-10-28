// Installed service packages and the definitions their install-service commands write, as
// the native start tests need them. (This file lives under test/ and defines no tests.)
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGES = {
  daemon: ['ours-daemon', '@ours.network/daemon', '5.0.0'],
  telegram: ['ours-tg-connector', '@ours.network/tg-connector', '2.0.0'],
  cowork: ['ours-cowork', '@ours.network/cowork', '2.0.0'],
};

/** Installs the service packages into workDir/node_modules with their .bin links, as npm does. */
export function installServicePackages(workDir, versions = {}) {
  const cli = {};
  for (const [service, [command, name, version]] of Object.entries(PACKAGES)) {
    const dir = join(workDir, 'node_modules', name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: versions[service] ?? version }));
    writeFileSync(join(dir, 'dist/cli.js'), '');
    const link = join(workDir, 'node_modules/.bin', command);
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(join('..', name, 'dist/cli.js'), link);
    cli[service] = join(dir, 'dist/cli.js');
  }
  return cli;
}

/** A definition in the recipe form install-service writes: [program, cli, serve]. */
export function recipeDefinition(platform, label, program, cli, environment = {}) {
  if (platform === 'darwin') {
    const env = Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join('');
    return `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${program}</string><string>${cli}</string><string>serve</string></array><key>EnvironmentVariables</key><dict>${env}</dict><key>RunAtLoad</key><true/></dict></plist>\n`;
  }
  const env = Object.entries(environment).map(([key, value]) => `Environment="${key}=${value}"\n`).join('');
  return `[Unit]\nDescription=ours\nAfter=network-online.target\n[Service]\nType=simple\nExecStart="${program}" "${cli}" serve\n${env}Restart=on-failure\n[Install]\nWantedBy=default.target\n`;
}

/** What `systemctl --user show <unit> -p ExecStart -p RootDirectory -p RootImage` prints for [program, ...args]. */
export function managerShow(program, args = ['/opt/ours/cli.js', 'serve'], root = '') {
  return `ExecStart={ path=${program} ; argv[]=${[program, ...args].join(' ')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\nRootDirectory=${root}\nRootImage=\n`;
}
