/** 核心算法测试：SQL 格式化、DDL 解析、高亮行切分。不依赖思源运行时。 */
import { formatSql } from "../src/sql/format";
import { highlightSql, highlightSqlInplace, highlightSqlLines } from "../src/sql/tokenizer";
import { parseCreateTables } from "../src/sql/ddl";

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        console.error(`✗ ${name}\n  实际: ${a}\n  期望: ${e}`);
    }
}

function show(name: string, value: string): void {
    console.log(`\n--- ${name} ---\n${value}`);
}

/* ------------------------------ 格式化 ------------------------------ */

const q1 = "select id,name,email from t_user where id>100 and name like '%a%' order by id desc limit 10";
const r1 = formatSql(q1);
show("format 基础查询", r1);
check("format 关键字大写", /^SELECT/.test(r1), true);
check("format 子句换行", r1.split("\n")[0].trim(), "SELECT");
check("format 包含 WHERE", r1.includes("\nWHERE"), true);
check("format 包含 ORDER BY", r1.includes("\nORDER BY"), true);
check("format 字符串未被改写", r1.includes("'%a%'"), true);
check("format 条件不丢", r1.includes("id > 100"), true);

const q2 = "select * from t where id in (select uid from log where ok=1) and x=2";
const r2 = formatSql(q2);
show("format 子查询", r2);
check("format 子查询缩进", /^\s+SELECT$/m.test(r2), true);
check("format 子查询闭合在新行", /\n\)/.test(r2), true);

const q3 = "insert into t(a,b)values(1,'x,y'),(2,'z')";
const r3 = formatSql(q3);
show("format INSERT", r3);
check("format INSERT 保留字符串逗号", r3.includes("'x,y'"), true);
check("format INSERT 表名不大写", r3.includes("INTO t"), true);
check("format INSERT 元组缩进", /\n {2}\(2, 'z'\)/.test(r3), true);

const q4 = "-- 注释\nselect 1 -- 尾注";
const r4 = formatSql(q4);
show("format 注释", r4);
check("format 保留行注释", r4.includes("-- 注释"), true);

// 回归：tokenizer 的 TYPES 分支曾为空分支，导致所有类型 token 被静默丢弃，
// 格式化后 DDL 会丢掉 BIGINT / VARCHAR / DATETIME 等类型名。
const q5 = "create table t(id bigint unsigned not null, name varchar(64) default '', ts datetime)";
const r5 = formatSql(q5);
show("format DDL", r5);
for (const kw of ["BIGINT", "VARCHAR", "DATETIME"]) {
    check(`format 不丢类型 ${kw}`, r5.toUpperCase().includes(kw), true);
}
// 类型/函数后的左括号必须紧贴（emit 曾把 token 类型写死成 ident 而失效）
check("format 类型括号紧贴", r5.includes("VARCHAR(64)"), true);
check("format 函数括号紧贴", formatSql("select count(*), concat(a,b) from t").includes("COUNT(*)"), true);
check("format 关键字括号留空", formatSql("select * from t where a in(1,2)").includes("IN ("), true);
check("format 表名括号留空", formatSql("insert into t(a) values(1)").includes("INTO t ("), true);

/* ------------------------------ 高亮行 ------------------------------ */

const multi = "SELECT 1,\n2,\n/* 跨行\n注释 */ 3";
const lines = highlightSqlLines(multi);
check("highlight 行数", lines.length, 4);
check("highlight 块注释不破坏结构", lines[2].includes("cr-cmt"), true);

/* ------------------------------ DDL 解析 ------------------------------ */

const ddl = `
CREATE TABLE IF NOT EXISTS \`t_order\` (
  \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`order_no\` varchar(64) NOT NULL DEFAULT '' COMMENT '订单号,唯一',
  \`amount\` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '金额',
  \`status\` tinyint(4) NOT NULL DEFAULT 0 COMMENT '状态',
  \`remark\` varchar(255) DEFAULT NULL COMMENT '备注',
  \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_order_no\` (\`order_no\`),
  KEY \`idx_status_created\` (\`status\`,\`created_at\`),
  CONSTRAINT \`fk_order_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`t_user\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

CREATE TABLE t_user (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name varchar(32) NOT NULL,
  PRIMARY KEY (id)
);
`;

const tables = parseCreateTables(ddl);
check("ddl 表数量", tables.length, 2);
check("ddl 表名", tables[0].name, "t_order");
check("ddl 字段数", tables[0].columns.length, 6);
check("ddl 自增", tables[0].columns[0].autoInc, true);
check("ddl 类型含长度", tables[0].columns[1].type, "varchar(64)");
check("ddl 默认空串", tables[0].columns[1].defaultValue, "");
check("ddl 注释带逗号", tables[0].columns[1].comment, "订单号,唯一");
check("ddl decimal 类型", tables[0].columns[2].type, "decimal(10,2)");
check("ddl 可空", tables[0].columns[4].nullable, true);
check("ddl 默认函数", tables[0].columns[5].defaultValue, "CURRENT_TIMESTAMP");
check("ddl 索引数", tables[0].indexes.length, 4);
check("ddl 唯一索引列", tables[0].indexes[1].columns, ["order_no"]);
check("ddl 复合索引列", tables[0].indexes[2].columns, ["status", "created_at"]);
check("ddl 外键", tables[0].indexes[3].reference?.table, "t_user");
check("ddl 表注释", tables[0].comment, "订单表");
check("ddl 引擎", tables[0].engine, "InnoDB");
check("ddl 字符集", tables[0].charset, "utf8mb4");
check("ddl 行内主键", tables[1].columns[0].primary, true);

const stripMarks = (html: string): string =>
    html
        .replace(/<[\/]?span[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");

/* --- 就地渲染：写进代码块的 HTML 去掉标签后必须与原 SQL 逐字相同 ---
 *
 * 这是整个插件最重要的不变量。就地渲染直接改代码块内容区，思源保存时
 * Lute 只取 textContent，一旦多/少一个字符就会污染用户笔记。
 */

const inplaceCases = [
    "select * from t",
    "SELECT a,\n  b\nFROM t\nWHERE a > 1 AND b LIKE '%x%'",
    "-- 中文注释\nSELECT `col`, 'a<b' FROM t WHERE x = \"y\"",
    "/* 块\n注释 */\nSELECT 1 -- 尾注",
    "INSERT INTO t VALUES (1, 'it''s'), (2, 'a,b')",
    "SELECT CONCAT(a, '&', b) FROM t WHERE c <> 5",
    // 类型 token 曾因 tokenizer 空分支被整个丢掉，这条用于回归
    "CREATE TABLE t (\n  id BIGINT UNSIGNED NOT NULL,\n  name VARCHAR(64) DEFAULT '',\n  ts DATETIME\n)",
    "SELECT CAST(x AS DECIMAL(10,2)), JSON_EXTRACT(d, '$.a') FROM t",
    "SELECT @@version, @v := 1, ? FROM DUAL",
];

for (const sql of inplaceCases) {
    const html = highlightSqlInplace(sql);
    check(`inplace 不改文本 ${sql.slice(0, 22).replace(/\n/g, "⏎")}`, stripMarks(html), sql);
    check(`inplace 行数一致 ${sql.slice(0, 22).replace(/\n/g, "⏎")}`, html.split("\n").length, sql.split("\n").length);
}

// 就地渲染必须用 hljs 类名（让用户选的代码主题接管配色），且绝不自绘行号
check("inplace 用 hljs 类名", highlightSqlInplace("select 1").includes('class="hljs-keyword"'), true);
check("inplace 不含插件配色类", /class="cr-(kw|str|num|typ|fn)"/.test(highlightSqlInplace("select 'a', 1")), false);
check("inplace 不自绘行号", highlightSqlInplace("select 1\nfrom t").includes("cr-ln"), false);
check("面板高亮仍用 cr- 类名", highlightSql("select 1").includes('class="cr-kw"'), true);

// 类型 token 不能被吞（tokenizer 的 TYPES 分支曾是空的）
check("类型 token 有色", highlightSqlInplace("id BIGINT").includes('class="hljs-type"'), true);
check("VARCHAR(64) 保留类型名", stripMarks(highlightSqlInplace("name VARCHAR(64)")), "name VARCHAR(64)");

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed) process.exit(1);
