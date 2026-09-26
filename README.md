# Codex 图片外置代理

**状态：临时方案。** 长期计划是换 dsh（它原生走 `file_id`）。这个代理是为了让现有的
图片密集 Codex 会话立刻能用，不用放弃历史。

---

## 问题是什么

Codex 把工具截图（computer-use / browser 插件产生的）以 **inline base64** 存进会话历史，
并且**每一轮都把完整历史重发一遍**。DeepSeek 网关对请求体有 **48 MiB（50,331,648 字节）** 硬上限，
图片密集的会话涨到上限之后，每一轮都返回：

```
413 Payload Too Large: Failed to buffer the request body: length limit exceeded
```

会话就此**永久卡死**——历史只增不减，不会自愈。

### 为什么自动压缩救不了

根因是**字节和 token 脱钩**：

| | 数值 | 相对上限 |
|---|---|---|
| token | 617K | 996K 窗口的 **62%** —— 压缩不触发 |
| 字节 | ~49 MB | 48 MiB 上限的 **102%** —— 已经撞满 |

base64 图片按 patch 计 token（很便宜），但字节巨大（约 **83 字节/token**，正常文本是 4）。
所以 token 计数远没到压缩线，字节已经撞顶。Codex 永远等不到触发压缩的那一刻。

**纯文本会话不会中招**——token 和字节同步增长，上下文先撞顶、压缩正常触发。
这个上限只对图片密集的会话构成威胁。

### 为什么不能靠配置解决

Codex **没有任何办法使用 Files API**：配置参考里没有这个开关，
[PR #45794](https://github.com/openai/codex/pull/45794) 才刚开始加 `file_id` 支持，
而且只覆盖 app-server 输入、不管工具输出。
`tool_output_token_limit`（默认 2,560）也拦不住——图片 token 太少，从预算底下溜过去了。

**这是客户端的能力缺口，不是配置问题。**

---

## 它怎么工作

```
Codex Desktop → codex.exe app-server
                     ↓  config.toml: base_url = http://127.0.0.1:8788
              图片外置代理
                     ↓  base64 → file_id（按内容 hash 缓存）
              api.deepseek.com
```

代理把每张图从请求里抽出来、上传到 DeepSeek Files API、原地换成约 60 字节的 `file_id`。
**模型仍然看得见每一张图**，只是请求不再携带像素。

实测：`49.11 MB -> 2.51 MB`，148 张截图全部保留。

---

## 文件

| 路径 | 作用 |
|---|---|
| `image-offload-proxy.mjs` | 代理本体（单文件、零依赖，需 Node 18+） |
| `%USERPROFILE%\.codex\image-offload-cache.json` | hash → file_id 缓存，重启不丢，**别删** |
| `%USERPROFILE%\.codex\image-offload-proxy.log` | 运行日志 |
| `%USERPROFILE%\.codex\config.toml.bak-before-proxy-20260926` | 改动前的配置备份 |

运行时状态**刻意放在仓库外**，可用 `CODEX_HOME` 覆盖。

---

## 日常使用

### 启动

```powershell
Start-Process node -ArgumentList "C:\repos\codex-image-offload-proxy\image-offload-proxy.mjs" `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$env:USERPROFILE\.codex\proxy-stdout.log" `
  -RedirectStandardError  "$env:USERPROFILE\.codex\proxy-stderr.log"
```

### 确认在跑

```powershell
Invoke-WebRequest http://127.0.0.1:8788/health -TimeoutSec 5
# {"ok":true,"cached":140,"upstream":"https://api.deepseek.com"}
```

`cached` 是已上传的图片数。第一次跑是 0，随截图增长。

### 看实时日志

```powershell
Get-Content "$env:USERPROFILE\.codex\image-offload-proxy.log" -Wait -Tail 20
```

### 停止

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*image-offload-proxy*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 日志怎么读

```
/responses 200 body 49.11 -> 2.51 MB (images 146/151 offloaded, 5 left inline, saved 46.60 MB) 8866ms last="response.completed" completed
```

| 字段 | 含义 |
|---|---|
| `body 49.11 -> 2.51 MB` | 进/出代理的请求体大小。左边接近 48 就是要撞上限的量 |
| `146/151 offloaded` | 151 张图里成功外置 146 张。**若是 `0/xxx`，代理没生效** |
| `5 left inline` | 上传失败的图，仍以 base64 发送，会拖高请求体。健康值是 0 |
| `completed` | 上游正常收到 `response.completed` |
| `WITHOUT response.completed` | 流被上游掐断 → Codex 会报 `stream closed before response.completed` |
| `!! stream ...` | 流异常，附带最后一个事件名 |

**一眼判断**：有 `completed` 且 `left inline` 为 0 = 完全健康。

---

## 配置

`%USERPROFILE%\.codex\config.toml`：

```toml
[model_providers.custom]
name = "deepseek"
base_url = "http://127.0.0.1:8788"      # 原来 = "https://api.deepseek.com"
wire_api = "responses"
```

环境变量（均可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CODEX_IMG_PROXY_PORT` | `8788` | 监听端口 |
| `CODEX_IMG_PROXY_UPSTREAM` | `https://api.deepseek.com` | 上游地址 |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | 缓存与日志位置 |

脚本内常量：

| 常量 | 默认 | 说明 |
|---|---|---|
| `MIN_OFFLOAD_BYTES` | `64 KiB` | 小于此值不外置（小图内联更快） |
| `UPLOAD_CONCURRENCY` | `4` | 并发上传数 |
| `UPLOAD_ATTEMPTS` | `3` | 上传失败重试次数（退避） |

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| Codex 报连不上 localhost | 代理没起 | 按上面命令启动 |
| Codex 报 `413` | 请求没走代理 | 检查 `base_url`；确认 **CC Switch 没在跑**（它会覆盖） |
| `stream closed before response.completed` | 上游掐断了慢请求（首轮上传 + 冷 prefill） | 重试；前缀缓存热了就快 |
| `left inline` 不为 0 | 某些图上传反复失败 | 看日志 `! upload failed`；下一轮通常会补上 |
| `offloaded` 是 `0/xxx` | Codex 换了序列化格式，代理静默失效 | 对照本文档的匹配形态改正则 |
| `invalid image data URL` / 图片 400 | `file_id` 在该回放路径上不被接受 | 这条路走不通，回滚并考虑 dsh |
| 改了 `config.toml` 不生效 | app-server 还持有旧配置 | **两者都要重启** |

### 重启 Codex Desktop

```powershell
Get-Process -Name "ChatGPT","codex" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 4
Start-Process explorer.exe -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
```

**注意**：`codex.exe app-server` 是独立进程，**它才是读 `config.toml` 的那个**。
只重启 UI 不够。

---

## 回滚

1. `config.toml` 里 `base_url` 改回 `https://api.deepseek.com`
2. 重启 Codex Desktop
3. 代理可留可停
4. 重新打开 CC Switch

备份：`%USERPROFILE%\.codex\config.toml.bak-before-proxy-20260926`

代理挂了不影响其他功能，只是 Codex 连不上——报错明确，不会静默出错。

---

## 限制（重要）

1. **`file_id` 会过期。** DeepSeek 的文件是远程副本，有有效期（观测上限约 30 天）。
   **代理没有续期逻辑**——超期后引用失效，需要重传。
   会话生命周期超过这个，就该换 dsh 了。

2. **CC Switch 一开就会覆盖 `base_url`**，代理被绕过。用代理期间别开它。

3. **只处理 `"image_url": "data:image/..."` 这一种形态。** 其他写法原样透传。
   Codex 若改了序列化格式，代理会静默失效——看 `offloaded` 是否为 0。

4. **必须保留图片对模型可见。** 这是这个工具存在的理由。任何"丢图/缩图/换成文字"
   的改法都违背前提，即使能让请求变小。

5. **不要重新序列化请求体。** 改写是对原始字符串做的定点正则替换，
   保证图片**周围**的字节逐字节不变（prompt cache 前缀）。解析再 stringify 会把整个
   49 MB 搅一遍。

---

## 为什么不做成持久服务

这是临时方案，不值得做开机自启。需要时常驻时手动起一下即可。

真要长期用，正确的做法是换原生支持 `file_id` 的 harness——dsh 的 `dsh-llm-deepseek`
默认就走 `/v1/files` + file-id 引用，`maxImagesPerRequest` 600、
`maxRequestFilesBytes` 128 MiB，且图片会自动规范化到单边 ≤4096px、单张 ≤2 MiB。

**这是桥，不是终点。**
