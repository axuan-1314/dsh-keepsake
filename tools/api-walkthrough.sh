# dsh-memory API 冒烟脚本：headless curl 把全部 REST 端点走一遍
# 顺序：0 清场（可重入）→ state → 改 settings → persona 写/重置 → 四分类增删改/移动 →
#       reset（验备份）→ import dryRun/confirm → export → backup list/restore → 收尾复位
# 用法：BASE=http://127.0.0.1:3080 bash tools/api-walkthrough.sh
# ⚠ Git Bash（MinGW curl）下命令行参数里的中文会被 ANSI argv 转换打坏（服务端收到 U+FFFD），
#    故带 body 的请求一律先写临时文件再 --data-binary @file，绕开命令行参数。
set -u
BASE="${BASE:-http://127.0.0.1:3080}"
API="$BASE/dsh-memory/api"

# 安全门：step 0 会 reset/清空目标宿主的全部记忆数据，
# 只许对一次性测试容器跑。默认拒绝执行；必须显式 WALKTHROUGH_CONFIRM=yes。
if [ "${WALKTHROUGH_CONFIRM:-}" != "yes" ]; then
  echo "⚠ 拒绝执行：本脚本会清空 $BASE 上的记忆数据（五分类+人设+称呼；自动备份留在 backups/）。"
  echo "  目标探测：HTTP $(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$API/state" 2>/dev/null || echo unreachable)"
  echo "  确认对一次性测试容器执行：WALKTHROUGH_CONFIRM=yes BASE=$BASE bash tools/api-walkthrough.sh"
  exit 1
fi

PASS=0
FAIL=0
REQTMP=$(mktemp)
trap 'rm -f "$REQTMP"' EXIT
# 带 JSON body 的请求：$1=方法 $2=body $3=URL
jreq() { printf '%s' "$2" > "$REQTMP"; curl -s -X "$1" -H "content-type: application/json" --data-binary "@$REQTMP" "$3"; }

step() { echo ""; echo "=== $1 ==="; }
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
jqv()  { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const j=JSON.parse(s);const v=eval('j.'+process.argv[1]);console.log(typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('PARSE_ERR')}})" "$1"; }

step "0. 清场（可重入）：reset 五分类 + persona 默认 + 称呼空"
for CAT in work-profile user-profile current-focus recent-activity long-term; do
  curl -s -X POST "$API/category/$CAT/reset" > /dev/null
done
curl -s -X POST "$API/persona/reset" > /dev/null
jreq PUT '{"dshName":"","userAlias":""}' "$API/addressing" > /dev/null
ok "清场完成（reset 自动留档备份属预期）"

step "1. GET state（轻态六要素）"
BODY=$(curl -s "$API/state")
echo "$BODY" | head -c 300; echo ""
[ "$(echo "$BODY" | jqv ok)" = "true" ] && ok "state 200 ok" || bad "state"
echo "$BODY" | jqv settings | grep -q conversationMemory && ok "settings 三开关在场" || bad "settings 缺"

step "2. PUT settings（改全局提取开关）"
BODY=$(jreq PUT '{"globalExtraction":false}' "$API/settings")
[ "$(echo "$BODY" | jqv settings.globalExtraction)" = "false" ] && ok "globalExtraction=false 生效" || bad "PUT settings: $BODY"
BODY=$(jreq PUT '{"globalExtraction":true}' "$API/settings")
[ "$(echo "$BODY" | jqv settings.globalExtraction)" = "true" ] && ok "恢复 true" || bad "恢复"

step "3. persona：GET 默认 → PUT 写 → POST reset"
BODY=$(curl -s "$API/persona")
[ "$(echo "$BODY" | jqv isDefault)" = "true" ] && ok "出厂默认模板" || bad "persona GET"
BODY=$(jreq PUT '{"content":"冒烟测试人设：直接简洁。"}' "$API/persona")
[ "$(echo "$BODY" | jqv ok)" = "true" ] && ok "persona 写入" || bad "persona PUT"
BODY=$(curl -s "$API/persona")
echo "$BODY" | jqv content | grep -q "冒烟测试人设" && ok "persona 读回一致" || bad "persona 读回: $BODY"
BODY=$(curl -s -X POST "$API/persona/reset")
echo "$BODY" | jqv content | grep -q "补充人设" && ok "persona reset 恢复默认" || bad "persona reset"

step "4. addressing：PUT → GET"
BODY=$(jreq PUT '{"dshName":"冒烟助手","userAlias":"冒烟朋友"}' "$API/addressing")
[ "$(echo "$BODY" | jqv dshName)" = "冒烟助手" ] && ok "addressing 写入" || bad "addressing PUT"
BODY=$(curl -s "$API/addressing")
[ "$(echo "$BODY" | jqv userAlias)" = "冒烟朋友" ] && ok "addressing 读回" || bad "addressing GET"

step "5. 四分类各新增一条 + 列表验证"
for CAT in work-profile user-profile current-focus recent-activity long-term; do
  BODY=$(jreq POST "{\"title\":\"walk $CAT\",\"description\":\"冒烟\",\"content\":\"$CAT 冒烟正文\"}" "$API/category/$CAT/entries")
  NAME=$(echo "$BODY" | jqv name)
  [ "$NAME" = "walk-$CAT.md" ] && ok "$CAT 新增 $NAME" || bad "$CAT 新增: $BODY"
done
BODY=$(curl -s "$API/category/recent-activity")
echo "$BODY" | jqv "entries[0].timestamp" | grep -q "^20" && ok "recent-activity timestamp 盖章" || bad "timestamp: $BODY"

step "6. PUT entry：改正文 + 跨分类移动（work→long-term）"
BODY=$(jreq PUT '{"category":"work-profile","name":"walk-work-profile.md","content":"改后的正文","toCategory":"long-term"}' "$API/entry")
[ "$(echo "$BODY" | jqv categoryId)" = "long-term" ] && ok "跨分类移动" || bad "PUT entry: $BODY"
BODY=$(curl -s "$API/category/work-profile")
[ "$(echo "$BODY" | jqv 'entries.length')" = "0" ] && ok "源分类已空" || bad "源分类未空"

step "7. DELETE entry"
BODY=$(jreq DELETE '{"category":"user-profile","name":"walk-user-profile.md"}' "$API/entry")
[ "$(echo "$BODY" | jqv existed)" = "true" ] && ok "删除成功" || bad "DELETE: $BODY"

step "8. POST category reset（验自动备份）"
BODY=$(curl -s -X POST "$API/category/current-focus/reset")
BACKUP_ID=$(echo "$BODY" | jqv backupId)
[ "$(echo "$BODY" | jqv removed)" = "1" ] && [ "$BACKUP_ID" != "PARSE_ERR" ] && ok "reset 清 1 条 + 备份 $BACKUP_ID" || bad "reset: $BODY"

step "9. import：dryRun 预览 → confirm 写入（验覆盖计数+备份）"
BODY=$(jreq POST '{"category":"long-term","format":"json","payload":{"entries":[{"title":"walk long-term","content":"覆盖新版本"},{"title":"import fresh","content":"全新条目"}]}}' "$API/import?dryRun=1")
PLANS=$(echo "$BODY" | jqv "plans.length")
ACT0=$(echo "$BODY" | jqv "plans[0].action")
[ "$PLANS" = "2" ] && [ "$ACT0" = "overwrite" ] && ok "dryRun 2 计划（overwrite+add 标红位）" || bad "dryRun: $BODY"
BODY=$(jreq POST '{"category":"long-term","format":"json","payload":{"entries":[{"title":"walk long-term","content":"覆盖新版本"},{"title":"import fresh","content":"全新条目"}]}}' "$API/import")
[ "$(echo "$BODY" | jqv written)" = "2" ] && [ "$(echo "$BODY" | jqv overwritten)" = "1" ] && ok "confirm 写 2 覆盖 1" || bad "confirm: $BODY"
BODY=$(curl -s "$API/category/long-term")
echo "$BODY" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);const e=j.entries.find(x=>x.name==='walk-long-term.md');console.log(e?e.content:'NOT_FOUND')})" | grep -q "覆盖新版本" && ok "覆盖内容已更新" || bad "覆盖内容"

step "10. GET export（全量 JSON）"
BODY=$(curl -s "$API/export")
CNT=$(echo "$BODY" | jqv "categories['long-term'].length")
[ "$CNT" = "3" ] && ok "export long-term 3 条" || bad "export: long-term=$CNT"

step "11. backup list / restore（恢复 reset 前的 current-focus）"
BODY=$(curl -s "$API/backup/list")
LIST_CNT=$(echo "$BODY" | jqv "backups.length")
echo "  备份数：$LIST_CNT（reset+import 两次自动留档，restore 前）"
[ "$LIST_CNT" -ge 2 ] 2>/dev/null && ok "backup list ≥2" || bad "backup list: $LIST_CNT"
BODY=$(jreq POST "{\"id\":\"$BACKUP_ID\"}" "$API/backup/restore")
[ "$(echo "$BODY" | jqv ok)" = "true" ] && ok "restore 成功（含 pre-restore 再备份）" || bad "restore: $BODY"
BODY=$(curl -s "$API/category/current-focus")
[ "$(echo "$BODY" | jqv 'entries.length')" = "1" ] && ok "current-focus 已恢复 1 条" || bad "恢复后计数: $BODY"

step "12. 守卫负路径（cross-site 403 / 非法分类 404）"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "sec-fetch-site: cross-site" "$API/state")
[ "$CODE" = "403" ] && ok "cross-site 403" || bad "cross-site: $CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/category/evil-cat")
[ "$CODE" = "404" ] && ok "非法分类 404" || bad "非法分类: $CODE"

step "13. 收尾复位：空分类 + 默认人设 + 空称呼（跑完不留脏数据）"
for CAT in work-profile user-profile current-focus recent-activity long-term; do
  curl -s -X POST "$API/category/$CAT/reset" > /dev/null
done
curl -s -X POST "$API/persona/reset" > /dev/null
jreq PUT '{"dshName":"","userAlias":""}' "$API/addressing" > /dev/null
ok "环境已复位（后续冒烟可直接重跑）"

echo ""
echo "==================================="
echo "结果：PASS=$PASS FAIL=$FAIL"
echo "==================================="
[ "$FAIL" = "0" ]
