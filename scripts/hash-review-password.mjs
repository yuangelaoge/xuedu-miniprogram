import { randomBytes, scryptSync } from 'node:crypto';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('请在本机交互终端运行，避免密码进入命令历史或日志。\n');
  process.exitCode = 1;
} else {
  process.stdout.write('审核密码（输入不显示）：');
  let password = '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    for (const char of chunk) {
      if (char === '\u0003') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); process.exit(130); }
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        if (!password || password.length > 128) { process.stderr.write('密码长度须为 1–128 字符。\n'); process.exitCode = 1; return; }
        const salt = randomBytes(16);
        const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
        password = '';
        process.stdout.write(`scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}\n`);
        return;
      }
      if (char === '\u007f') password = password.slice(0, -1);
      else password += char;
    }
  });
}
