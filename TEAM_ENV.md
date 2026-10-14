# 团队加密配置

公开仓库中的 `.env.enc` 是负责人本机 `.env` 的加密快照。它包含已配置的高德和 DeepSeek 等参数，不包含 PostgreSQL 数据、用户记录、SSH 私钥、服务器生产配置或本机 `.runtime` 数据。明文 `.env` 和解密密码始终不提交 Git。

## 组员第一次使用

1. 安装项目使用的 Node.js 24，克隆仓库。
2. 通过团队私下渠道向负责人获取 43 位解密密码，不把密码贴在 GitHub Issue、PR 或公开聊天中。
3. 在项目根目录执行，按提示粘贴密码并回车，输入不会回显：

   ```powershell
   node scripts/team-env.mjs decrypt
   ```

4. 成功后根目录生成 `.env`。脚本只使用 Node.js 内置模块，解密不需要先安装 npm 依赖。
5. 如已有 `.env`，脚本会停止，请先自行备份或移走旧文件；不会自动合并、覆盖。

也可以把单行密码存入本机忽略目录 `.runtime/team-env/passphrase.txt`，再执行：

```powershell
node scripts/team-env.mjs decrypt --password-file .runtime/team-env/passphrase.txt
```

不要把密码作为命令行参数填写。Windows 文件权限继承所在目录；密码文件应保存在自己的用户目录下。

## 配置的适用范围

- 这是后端开发配置，不能打包进前端、鸿蒙客户端或公开下载产物。仅体验或联调云端应用时，直接使用 https://trip.seatraces.com 即可，无需解密。
- `OSM_SERVICE_URL` 仍然是负责人本机可用的地址。复制 `.env` 不会创建 SSH 隧道，也不会授予云端地点库访问权限。独立开发后端前，须另行准备可用的地点服务；不要直接开放数据库公网端口。
- 独立开发数据库按 README 使用 `npm ci`、`npm run dev` 初始化，原有账号、历史行程不会随加密包复制。
- 高德 Key 的白名单、DeepSeek 余额及配额仍按平台配置生效；团队调用共用这些凭据的额度。
- 解密包并不会覆盖云端生产环境，本次也没有重启线上服务。

## 负责人更新快照

修改本机 `.env` 后执行：

```powershell
node scripts/team-env.mjs encrypt
```

第一次会生成 32 字节安全随机密码，仅写入 `.runtime/team-env/passphrase.txt`；后续复用该文件。每次重新生成随机盐及 IV，使用 scrypt（N=131072、r=8、p=1）派生密钥，AES-256-GCM 加密并校验完整性。脚本先验证解密结果与原文件逐字节一致，再替换 `.env.enc`。只提交 `.env.enc`，不要提交 `.env` 或密码文件。

需要更换密码时，先将旧密码文件安全移走，再执行加密；旧密码仍可解开 Git 历史中的旧快照。如果旧解密密码泄露，应同时更换快照中涉及的服务密钥，单纯重新加密不能撤销旧密钥。

验证脚本：`node --test test/team-env.test.mjs`，检查完整解密、错误密码/篡改拒绝，以及已有 `.env` 不被覆盖。
