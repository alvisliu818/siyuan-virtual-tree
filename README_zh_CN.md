# 代码块渲染（Code Block Render）

为思源代码块挂载**自定义渲染器**的插件框架，内置 **MySQL / SQL** 预设。

## 特性

### 1. 通用渲染框架
按「代码块语言标识 → 渲染器 + 模式」配置规则，可自由增删。任何语言都能挂上自己的渲染方式。

### 2. 渲染位置可切换
- **就地**：直接改写代码块原生内容区的着色（取代思源自带的高亮，思源语言表里没有 `mysql`，原生根本不高亮）
- **面板**：在代码块下方展开
- **两者**（默认）

### 2. 内置 MySQL / SQL 渲染器，三种模式

| 模式 | 作用 |
| --- | --- |
| **美化** | SQL 语法高亮 + 自动格式化（关键字大写、子句换行、字段/条件逐项缩进）、行号、一键复制、一键把格式化结果写回代码块 |
| **表结构** | 解析 `CREATE TABLE`，渲染成表结构卡：字段（类型 / 可空 / 默认值 / 注释 / 主键 / 自增）、索引（PRIMARY / UNIQUE / INDEX / FULLTEXT / FOREIGN KEY）、表注释与 ENGINE/CHARSET |
| **执行** | 选数据源跑 SQL，结果渲染成可横向滚动的表格，支持导出 CSV |

### 3. 数据源
- **思源内置数据库（SQLite）**：直接调用思源内核 `/api/query/sql`，零配置即可查询自己的笔记库。
- **HTTP 代理（外部 MySQL）**：浏览器前端无法直连 MySQL，因此插件把 SQL POST 给你自己的代理服务，由代理连库执行后回传 JSON。

## 渲染位置

设置里可选：

| 选项 | 效果 |
| --- | --- |
| **就地（改原生渲染）** | 直接改写代码块内容区的着色，取代思源原生 hljs 高亮，代码块本身的位置和编辑方式完全不变 |
| **面板** | 只在代码块下方展开渲染面板 |
| **两者**（默认） | 代码块就地获得高亮，同时保留右上角的面板入口 |

就地渲染的实现要点：

- 只往内容区加 `<span>` 标记，**不改变 textContent**，所以不会被思源保存进文档（思源原生高亮也是同样的做法）。
- 行号用**空 span + CSS counter** 绘制，伪元素内容不参与文本，因此开启行号同样安全。
- 通过 MutationObserver 在思源重新高亮后再次接管；**代码块处于编辑焦点时绝不改写**，避免光标跳位。

> 就地渲染只做着色，不做格式化——格式化会改变文本内容，那属于改文档，需要通过「格式化」按钮主动写回。

## 设置

设置 → 插件 → 代码块渲染：

- **外观与行为**：自动渲染、是否显示渲染按钮、结果最大行数、高亮配色（跟随主题 / 浅色 / 深色）
- **渲染规则**：语言标识、渲染器、默认模式、启用、自动展开
- **数据源**：名称、类型、代理地址、令牌、只读、默认

默认预置一条规则：`mysql` → MySQL 渲染器 → 美化模式，自动展开。

## HTTP 代理协议

**请求**

```http
POST /query
Content-Type: application/json
Authorization: Bearer <token>      # 可选

{ "sql": "SELECT * FROM t LIMIT 10", "maxRows": 200 }
```

**响应**（三选一均可）

```json
{ "columns": ["id", "name"], "rows": [[1, "a"], [2, "b"]] }
```
```json
{ "data": [{ "id": 1, "name": "a" }] }
```
```json
[{ "id": 1, "name": "a" }]
```

非查询类可额外返回 `{"affectedRows": 3}`。出错时返回 `{"error": "错误信息"}`。

**最小参考实现（Node + mysql2）**

```js
import http from "node:http";
import mysql from "mysql2/promise";

const pool = mysql.createPool({ host: "127.0.0.1", user: "root", password: "", database: "test" });

http.createServer(async (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
        try {
            const { sql, maxRows = 200 } = JSON.parse(body || "{}");
            const [rows, fields] = await pool.query(sql);
            res.setHeader("Content-Type", "application/json");
            if (Array.isArray(rows)) {
                res.end(JSON.stringify({
                    columns: fields.map((f) => f.name),
                    rows: rows.slice(0, maxRows).map((r) => fields.map((f) => r[f.name])),
                }));
            } else {
                res.end(JSON.stringify({ affectedRows: rows.affectedRows }));
            }
        } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
        }
    });
}).listen(8080);
```

## 安全提示

- 数据源默认勾选**只读**：只读模式下只允许 `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH`，其余语句直接拒绝。
- 关闭只读后，非查询语句执行前会弹确认框，SQL 内容由你自己负责。
- HTTP 代理地址与令牌只存在本地插件存储里，请只在可信网络中使用，并自行限制代理服务的权限（建议代理侧也做只读账号 + 语句白名单）。

## 开发

```bash
npm install
npm run build          # 产出 dist/index.js（CJS）+ dist/index.css
node scripts/verify-load.cjs   # 沙箱验证产物可被思源 require
node scripts/run-sql-test.mjs  # 格式化 / DDL 解析算法测试
```

## 许可

MIT
