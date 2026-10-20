const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const electron = process.env.ELECTRON_EXEC
  || path.resolve(__dirname, '../../out/Release/electron.exe');
const script = path.join(__dirname, 'custom-apis.js');

if (!fs.existsSync(electron)) {
  console.error('找不到 Electron 可执行文件:', electron);
  console.error('可设置 ELECTRON_EXEC 指向 out/Release/electron.exe');
  process.exit(1);
}

const child = spawn(electron, [script], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    console.error('测试进程被信号结束:', signal);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
