// 記録リマインダーの送信スクリプト（GitHub Actionsから毎時実行される）
// - GIST_TOKEN でユーザーのGistから家計簿データを読む
// - リマインダーが有効で、現在の日本時間がその時刻で、今日まだ支出の記録が無ければ、
//   登録された全端末にWeb Pushを送る
// 必要なSecrets: GIST_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY

const GIST_FILE = "kakeibo-data.json";

function jstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000); // UTC+9
}
function jstDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function gistApi(path, token) {
  const res = await fetch("https://api.github.com" + path, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

export function shouldSend(state, now) {
  if (!state || !state.reminder || !state.reminder.enabled) return { send: false, reason: "リマインダー無効" };
  if (!Array.isArray(state.pushSubs) || state.pushSubs.length === 0) return { send: false, reason: "登録端末なし" };
  const hour = now.getUTCHours(); // jstNow()は+9時間済みなのでUTC時が日本時間
  if (hour !== Number(state.reminder.hour)) return { send: false, reason: `時刻不一致 (現在${hour}時 / 設定${state.reminder.hour}時)` };
  const today = jstDateStr(now);
  const recorded = Array.isArray(state.expenses) && state.expenses.some(e => e.date === today);
  if (recorded) return { send: false, reason: "今日はすでに記録済み" };
  return { send: true, reason: "送信条件を満たしました" };
}

async function main() {
  // テストモード: node send-reminder.mjs --test fixture.json [hour]
  if (process.argv[2] === "--test") {
    const { readFileSync } = await import("node:fs");
    const state = JSON.parse(readFileSync(process.argv[3], "utf8"));
    const now = jstNow();
    if (process.argv[4] !== undefined) now.setUTCHours(Number(process.argv[4]));
    console.log(JSON.stringify(shouldSend(state, now)));
    return;
  }

  const token = process.env.GIST_TOKEN;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!token || !vapidPublic || !vapidPrivate) {
    console.log("Secrets（GIST_TOKEN / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）が未設定のため何もしません");
    return;
  }

  // 家計簿データのGistを探す
  let gist = null;
  for (let page = 1; page <= 3 && !gist; page++) {
    const gists = await gistApi(`/gists?per_page=100&page=${page}`, token);
    gist = gists.find(g => g.files && g.files[GIST_FILE]) || null;
    if (gists.length < 100) break;
  }
  if (!gist) { console.log("家計簿データのGistが見つかりません"); return; }

  const detail = await gistApi("/gists/" + gist.id, token);
  const f = detail.files[GIST_FILE];
  const content = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  const state = JSON.parse(content);

  const now = jstNow();
  const verdict = shouldSend(state, now);
  console.log(verdict.reason);
  if (!verdict.send) return;

  const { default: webpush } = await import("web-push");
  webpush.setVapidDetails("mailto:reminder@example.com", vapidPublic, vapidPrivate);
  const payload = JSON.stringify({
    title: "日別収支カレンダー",
    body: "今日の支出をまだ記録していません。タップして記録しましょう",
  });
  let ok = 0, gone = 0, failed = 0;
  for (const sub of state.pushSubs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) gone++;
      else { failed++; console.log("送信失敗:", e.statusCode || e.message); }
    }
  }
  console.log(`送信完了: 成功${ok} / 期限切れ${gone} / 失敗${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
