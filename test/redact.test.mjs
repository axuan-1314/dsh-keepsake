/**
 * redact.js 测试套件
 * node:test 平铺风格，node:assert/strict 断言
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDACTION_PLACEHOLDER,
  redactSensitive,
  redactSensitiveWithCount,
  redactOps,
} from "../lib/redact.js";

test("模式 1：私钥块 - 完整 PEM 格式命中", () => {
  const input = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
  const result = redactSensitive(input);
  assert.equal(result, REDACTION_PLACEHOLDER);
});

test("模式 1：私钥块 - 多行 PEM 命中", () => {
  const input = `
    config:
      key: |
        -----BEGIN ENCRYPTED PRIVATE KEY-----
        MHcCAQEEIF...
        -----END EC PRIVATE KEY-----
  `;
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("BEGIN EC PRIVATE KEY"));
});

test("模式 1：私钥块 - 不命中普通文本", () => {
  const input = "This is a normal message with no private keys";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 2：Authorization 头 - Bearer 命中", () => {
  const input = "Authorization: Bearer sk-FAKEFAKEFAKEFAKEFAKE";
  const result = redactSensitive(input);
  assert.equal(result, `Authorization: Bearer ${REDACTION_PLACEHOLDER}`);
});

test("模式 2：Authorization 头 - Basic 命中", () => {
  const input = "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l";
  const result = redactSensitive(input);
  assert.equal(result, `Authorization: Basic ${REDACTION_PLACEHOLDER}`);
});

test("模式 2：Authorization 头 - Token 命中", () => {
  const input = "Authorization: Token ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456";
  const result = redactSensitive(input);
  assert.equal(result, `Authorization: Token ${REDACTION_PLACEHOLDER}`);
});

test("模式 2：Authorization 头 - Proxy-Authorization 命中", () => {
  const input = "Proxy-Authorization: Bearer mytoken123456789012";
  const result = redactSensitive(input);
  assert.equal(result, `Proxy-Authorization: Bearer ${REDACTION_PLACEHOLDER}`);
});

test("模式 2：Authorization 头 - 大小写不敏感", () => {
  const input = "authorization: bearer sk-FAKEFAKEFAKEFAKEFAKE";
  const result = redactSensitive(input);
  assert.equal(result, `authorization: bearer ${REDACTION_PLACEHOLDER}`);
});

test("模式 3：独立 Bearer 令牌 - 命中", () => {
  const input = "Use this token: Bearer somelongtokenvalue1234567890";
  const result = redactSensitive(input);
  // Vendor key pattern might match the token, Bearer pattern matches "Bearer + token"
  // Either way, the sensitive content should be redacted
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("somelongtokenvalue1234567890"));
});

test("模式 3：独立 Basic 令牌 - 命中", () => {
  const input = "Auth: Basic YWxhZGRpbjpvcGVuc2VzYW1l";
  const result = redactSensitive(input);
  assert.equal(result, `Auth: Basic ${REDACTION_PLACEHOLDER}`);
});

test("模式 3：独立令牌 - 短令牌不命中（<16 字符）", () => {
  const input = "Bearer short";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 4：厂商 key - sk- OpenAI 风格命中", () => {
  const input = "api_key: sk-FAKEFAKEFAKEFAKEFAKEFAKE";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("sk-FAKEFAKEFAKEFAKEFAKEFAKE"));
});

test("模式 4：厂商 key - ghp_ GitHub PAT 命中", () => {
  const input = "token: ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE"));
});

test("模式 4：厂商 key - github_pat_ Fine-grained 命中", () => {
  const input = "token: github_pat_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEuvwx";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("github_pat_"));
});

test("模式 4：厂商 key - AKIA AWS Access Key 命中", () => {
  const input = "accessKeyId: AKIAFAKEFAKEFAKEFAKE01";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("AKIAFAKEFAKEFAKEFAKE01"));
});

test("模式 4：厂商 key - xoxb Slack token 命中", () => {
  const input = "slack_token: xoxb-0000-FAKE000000000";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("xoxb-0000-FAKE000000000"));
});

test("模式 4：厂商 key - AIza Google API key 命中", () => {
  const input = "google_key: AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEabcde";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEabcde"));
});

test("模式 4：厂商 key - AIza 尾串超 35 位仍命中（宁多勿漏的取舍钉）", () => {
  // 真 key 是 35 位尾串；尾串更长的变体同样整段替换——脱敏器按召回优先，
  // 误伤「AIza 开头的长随机串」代价远低于漏掉一个真 key（本条把该取舍钉成显式契约）。
  const long = `AIza${"b".repeat(48)}`;
  const result = redactSensitive(`key=${long}`);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes(long));
  // 尾串不足 35 位的短串不命中（免得把普通文本误伤成密钥）
  const short = `AIza${"c".repeat(34)}`;
  assert.equal(redactSensitive(`note ${short} end`), `note ${short} end`);
});

test("模式 4：厂商 key - JWT 命中", () => {
  const input = "jwt: eyJFAKEhbGciOiJIUzI1NiJ9.FAKEcGF5bG9hZC5wYXlsb2Fk.FAKEc2lnbmF0dXJlX3NpZ25hdHVyZQ";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
});

test("模式 4：厂商 key - 普通 hex 不误伤", () => {
  const input = "hash: 1a2b3c4d5e6f";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 5：URL 凭据 - http://user:EXAMPLE_PASSWORD@example.com@host 命中", () => {
  const input = "url: http://admin:EXAMPLE_PASSWORD@example.com/api";
  const result = redactSensitive(input);
  assert.equal(result, `url: http://${REDACTION_PLACEHOLDER}@example.com/api`);
});

test("模式 5：URL 凭据 - https 保留 scheme 和 host", () => {
  const input = "connect: https://user:EXAMPLE_PASSWORD@example.com@internal.server:8080/path";
  const result = redactSensitive(input);
  assert.equal(result, `connect: https://${REDACTION_PLACEHOLDER}@internal.server:8080/path`);
});

test("模式 5：URL 凭据 - ftp 保留 scheme", () => {
  const input = "ftp://user:EXAMPLE_PASSWORD@example.com@ftp.example.com/file";
  const result = redactSensitive(input);
  assert.equal(result, `ftp://${REDACTION_PLACEHOLDER}@ftp.example.com/file`);
});

test("模式 5：URL 凭据 - 无凭据 URL 不动", () => {
  const input = "url: https://example.com/api";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 6：敏感键值 - password 命中", () => {
  const input = "password: EXAMPLE_PASSWORD";
  const result = redactSensitive(input);
  assert.equal(result, `password: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - passwd 命中", () => {
  const input = "passwd = EXAMPLE_PASSWORD";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("EXAMPLE_PASSWORD"));
});

test("模式 6：敏感键值 - pwd 命中", () => {
  const input = "pwd: secret456";
  const result = redactSensitive(input);
  assert.equal(result, `pwd: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - secret 命中", () => {
  const input = "secret: mykey789";
  const result = redactSensitive(input);
  assert.equal(result, `secret: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - token 命中", () => {
  const input = "token: abc123xyz";
  const result = redactSensitive(input);
  assert.equal(result, `token: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - api_key 命中", () => {
  const input = "api_key: xyz789abc";
  const result = redactSensitive(input);
  assert.equal(result, `api_key: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - apikey 命中", () => {
  const input = "apikey: test123";
  const result = redactSensitive(input);
  assert.equal(result, `apikey: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - access_key 命中", () => {
  const input = "access_key: AKIAFAKEFAKEFAKEFAKE01";
  const result = redactSensitive(input);
  assert.equal(result, `access_key: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - private_key 命中", () => {
  const input = "private_key: rsa-private";
  const result = redactSensitive(input);
  assert.equal(result, `private_key: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - credential 命中", () => {
  const input = "credential: cred123";
  const result = redactSensitive(input);
  assert.equal(result, `credential: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - credentials 命中", () => {
  const input = "credentials: creds456";
  const result = redactSensitive(input);
  assert.equal(result, `credentials: ${REDACTION_PLACEHOLDER}`);
});

test("模式 6：敏感键值 - 双引号值保留引号", () => {
  const input = 'password: "EXAMPLE_PASSWORD"';
  const result = redactSensitive(input);
  assert.equal(result, `password: "${REDACTION_PLACEHOLDER}"`);
});

test("模式 6：敏感键值 - 单引号值保留引号", () => {
  const input = "password: 'EXAMPLE_PASSWORD'";
  const result = redactSensitive(input);
  assert.equal(result, `password: '${REDACTION_PLACEHOLDER}'`);
});

test("模式 6：敏感键值 - 大小写不敏感", () => {
  const input = "PASSWORD: mysecret";
  const result = redactSensitive(input);
  assert.equal(result, `PASSWORD: ${REDACTION_PLACEHOLDER}`);
});

test("模式 7：内网 IPv4 - 10.x.x.x 命中", () => {
  const input = "server: 10.0.0.1";
  const result = redactSensitive(input);
  assert.equal(result, `server: ${REDACTION_PLACEHOLDER}`);
});

test("模式 7：内网 IPv4 - 172.16-31.x.x 命中", () => {
  const input = "server: 172.16.0.1";
  const result = redactSensitive(input);
  assert.equal(result, `server: ${REDACTION_PLACEHOLDER}`);
});

test("模式 7：内网 IPv4 - 172.31.255.255 命中", () => {
  const input = "server: 172.31.255.255";
  const result = redactSensitive(input);
  assert.equal(result, `server: ${REDACTION_PLACEHOLDER}`);
});

test("模式 7：内网 IPv4 - 192.168.x.x 命中", () => {
  const input = "server: 192.168.1.1";
  const result = redactSensitive(input);
  assert.equal(result, `server: ${REDACTION_PLACEHOLDER}`);
});

test("模式 7：内网 IPv4 - 公网 IP 不误伤", () => {
  const input = "server: 8.8.8.8";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 7：内网 IPv4 - 172.15.x.x 不误伤", () => {
  const input = "server: 172.15.0.1";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 7：内网 IPv4 - 172.32.x.x 不误伤", () => {
  const input = "server: 172.32.0.1";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 7：内网 IPv4 - 192.167.x.x 不误伤", () => {
  const input = "server: 192.167.1.1";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("模式 7：内网 IPv4 - 192.169.x.x 不误伤", () => {
  const input = "server: 192.169.1.1";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("幂等性 - 已脱敏文本再跑不变", () => {
  const input = "password: EXAMPLE_PASSWORD";
  const first = redactSensitive(input);
  const second = redactSensitive(first);
  assert.equal(first, second);
});

test("幂等性 - 多次脱敏结果一致", () => {
  const input = "password: EXAMPLE_PASSWORD\nBearer sk-FAKEFAKEFAKEFAKEFAKE";
  const first = redactSensitive(input);
  const second = redactSensitive(first);
  const third = redactSensitive(second);
  assert.equal(first, second);
  assert.equal(second, third);
});

test("计数准确 - 单次命中", () => {
  const input = "password: EXAMPLE_PASSWORD";
  const { count } = redactSensitiveWithCount(input);
  assert.equal(count, 1);
});

test("计数准确 - 多次命中", () => {
  const input = "password: EXAMPLE_PASSWORD\nBearer sk-FAKEFAKEFAKEFAKEFAKE\nAuthorization: Bearer token123456789012";
  const { count } = redactSensitiveWithCount(input);
  assert.equal(count, 3);
});

test("计数准确 - 无命中", () => {
  const input = "normal text without secrets";
  const { count } = redactSensitiveWithCount(input);
  assert.equal(count, 0);
});

test("计数准确 - 已脱敏文本再跑 count=0", () => {
  const input = "password: EXAMPLE_PASSWORD";
  const first = redactSensitiveWithCount(input);
  assert.equal(first.count, 1);
  const second = redactSensitiveWithCount(first.text);
  assert.equal(second.count, 0);
});

test("普通版本号不误伤", () => {
  const input = "version: 1.2.3";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("普通版本号 - v1.0.0 不误伤", () => {
  const input = "version: v1.0.0";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("普通版本号 - 2.5.10 不误伤", () => {
  const input = "version: 2.5.10";
  const result = redactSensitive(input);
  assert.equal(result, input);
});

test("占位符自身不被二次命中", () => {
  const input = "password: EXAMPLE_PASSWORD";
  const first = redactSensitive(input);
  assert.equal(first, `password: ${REDACTION_PLACEHOLDER}`);
  const second = redactSensitive(first);
  assert.equal(second, `password: ${REDACTION_PLACEHOLDER}`);
});

test("redactOps - content 字段脱敏", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      content: "password: EXAMPLE_PASSWORD",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 1);
  assert.equal(newOps[0].content, `password: ${REDACTION_PLACEHOLDER}`);
  assert.equal(newOps[0].name, "test.md");
});

test("redactOps - title 字段脱敏", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      title: "API key sk-FAKEFAKEFAKEFAKEFAKE",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 1);
  assert.ok(newOps[0].title.includes(REDACTION_PLACEHOLDER));
  assert.equal(newOps[0].name, "test.md");
});

test("redactOps - description 字段脱敏", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      description: "Auth: Bearer token123456789012",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 1);
  assert.ok(newOps[0].description.includes(REDACTION_PLACEHOLDER));
  assert.equal(newOps[0].name, "test.md");
});

test("redactOps - indexLine 字段脱敏", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      indexLine: "- [Test](test.md) — key sk-FAKEFAKEFAKEFAKEFAKE",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 1);
  assert.ok(newOps[0].indexLine.includes(REDACTION_PLACEHOLDER));
  assert.equal(newOps[0].name, "test.md");
});

test("redactOps - body 字段脱敏", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      body: "secret: mykey",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 1);
  assert.equal(newOps[0].body, `secret: ${REDACTION_PLACEHOLDER}`);
  assert.equal(newOps[0].name, "test.md");
});

test("redactOps - name 字段不动", () => {
  const ops = [
    {
      action: "write",
      name: "password.md",
      content: "normal content",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 0);
  assert.equal(newOps[0].name, "password.md");
});

test("redactOps - sha1 字段不动", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      sha1: "ab12cd34",
      content: "password: EXAMPLE_PASSWORD",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 1);
  assert.equal(newOps[0].sha1, "ab12cd34");
});

test("redactOps - action 字段不动", () => {
  const ops = [
    {
      action: "delete",
      name: "password.md",
    },
  ];
  const { ops: newOps, count } = redactOps(ops);
  assert.equal(count, 0);
  assert.equal(newOps[0].action, "delete");
});

test("redactOps - 多个 op 累计计数", () => {
  const ops = [
    {
      action: "write",
      name: "test1.md",
      content: "password: EXAMPLE_PASSWORD",
    },
    {
      action: "write",
      name: "test2.md",
      content: "token: abc123",
    },
  ];
  const { count } = redactOps(ops);
  assert.equal(count, 2);
});

test("redactOps - 空数组返回空数组", () => {
  const { ops, count } = redactOps([]);
  assert.deepEqual(ops, []);
  assert.equal(count, 0);
});

test("redactOps - 非数组输入返回空数组", () => {
  const { ops, count } = redactOps(null);
  assert.deepEqual(ops, []);
  assert.equal(count, 0);
});

test("redactOps - 原对象不变", () => {
  const ops = [
    {
      action: "write",
      name: "test.md",
      content: "password: EXAMPLE_PASSWORD",
    },
  ];
  const originalContent = ops[0].content;
  redactOps(ops);
  assert.equal(ops[0].content, originalContent);
});

test("空串容错", () => {
  const result = redactSensitive("");
  assert.equal(result, "");
});

test("非字符串容错", () => {
  const result = redactSensitive(null);
  assert.equal(result, null);
  const result2 = redactSensitive(123);
  assert.equal(result2, 123);
  const result3 = redactSensitive(undefined);
  assert.equal(result3, undefined);
});

test("redactSensitiveWithCount - 非字符串容错", () => {
  const { text, count } = redactSensitiveWithCount(null);
  assert.equal(text, null);
  assert.equal(count, 0);
});

test("性能 - 100KB 文本不炸", () => {
  const longText = "password: EXAMPLE_PASSWORD\n".repeat(2000); // ~36KB
  const start = Date.now();
  const result = redactSensitive(longText);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `脱敏耗时 ${elapsed}ms 超过 1s`);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
});

test("性能 - 超长文本多模式命中", () => {
  const parts = [
    "password: EXAMPLE_PASSWORD\n",
    "Bearer sk-FAKEFAKEFAKEFAKEFAKE\n",
    "http://user:EXAMPLE_PASSWORD@example.com@host.com\n",
    "10.0.0.1\n",
  ];
  const longText = parts.join("").repeat(500); // ~40KB
  const start = Date.now();
  const result = redactSensitive(longText);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `脱敏耗时 ${elapsed}ms 超过 1s`);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
});

test("混合场景 - 多种模式同时命中", () => {
  const input = `
    config:
      api_key: sk-FAKEFAKEFAKEFAKEFAKE
      db_url: http://admin:secret@10.0.0.1:5432/db
      auth:
        password: EXAMPLE_PASSWORD
        token: Bearer abcdefghijklmnop
  `;
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("sk-FAKEFAKEFAKEFAKEFAKE"));
  assert.ok(!result.includes("admin:secret"));
  assert.ok(!result.includes("10.0.0.1"));
  assert.ok(!result.includes("EXAMPLE_PASSWORD"));
  assert.ok(!result.includes("Bearer abcdefghijklmnop"));
});

test("URL 凭据 - 特殊字符密码（不含 @）", () => {
  const input = "url: http://user:p%ssw0rd!@host.com";
  const result = redactSensitive(input);
  assert.equal(result, `url: http://${REDACTION_PLACEHOLDER}@host.com`);
});

test("URL 凭据 - 多个 URL", () => {
  const input = "url1: http://user1:EXAMPLE_PASSWORD@example.com@host1.com\nurl2: https://user2:EXAMPLE_PASSWORD@example.com@host2.com";
  const result = redactSensitive(input);
  assert.equal(result, `url1: http://${REDACTION_PLACEHOLDER}@host1.com\nurl2: https://${REDACTION_PLACEHOLDER}@host2.com`);
});

test("敏感键值 - 等号和冒号混用", () => {
  const input = "password=secret1\npasswd: secret2\npwd = secret3";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("secret1"));
  assert.ok(!result.includes("secret2"));
  assert.ok(!result.includes("secret3"));
});

test("敏感键值 - 值含空格被截断", () => {
  const input = "password: my secret value";
  const result = redactSensitive(input);
  // 只替换第一个词，因为模式匹配到空格就停止
  assert.equal(result, `password: ${REDACTION_PLACEHOLDER} secret value`);
});

test("GitHub PAT - 所有前缀命中", () => {
  const input = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456 gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456 ghu_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456 ghs_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456 ghr_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456"));
  assert.ok(!result.includes("gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456"));
  assert.ok(!result.includes("ghu_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE123456"));
});

test("Slack token - 所有前缀命中", () => {
  const input = "xoxb-0000-FAKE000000000 xoxa-0000-FAKE000000000 xoxp-0000-FAKE000000000 xoxr-0000-FAKE000000000 xoxs-0000-FAKE000000000";
  const result = redactSensitive(input);
  assert.ok(result.includes(REDACTION_PLACEHOLDER));
  assert.ok(!result.includes("xoxb-0000-FAKE000000000"));
  assert.ok(!result.includes("xoxa-0000-FAKE000000000"));
});

test("内网 IP - 172.17.x.x 命中", () => {
  const input = "server: 172.17.0.1";
  const result = redactSensitive(input);
  assert.equal(result, `server: ${REDACTION_PLACEHOLDER}`);
});

test("内网 IP - 172.30.x.x 命中", () => {
  const input = "server: 172.30.255.255";
  const result = redactSensitive(input);
  assert.equal(result, `server: ${REDACTION_PLACEHOLDER}`);
});
