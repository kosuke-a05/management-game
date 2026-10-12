/*
  美濃路食堂 シフト自動作成エンジン（お試し版・月単位）
  - ブラウザでは window.ShiftEngine、Node では require() で使える
  - 考え方：
    ・スタッフごとに「いつもの出られる時間帯（曜日×朝昼夜）」を1回だけ決めておく
    ・毎月は「予定がある日」だけを申告する（申告しなかった日は出られる扱い）
    ・出られる＝ いつもの時間帯に入っていて、かつ予定あり日ではない
  - 清水さんのルール：
    1. 各枠に最低1人ベテラン（新人だけの時間帯を作らない。昼ピークは特に必須）
    2. 学生は土日の昼を優先して入れる
    3. 月の上限時間（扶養内など）を超えない
    4. 朝（7:00〜）は本店のみ。早朝に出られる人だけ
    5. 本人が出られない日・時間帯には入れない
    6. 同じ時間に2店舗かけもちはしない。1日最大2枠まで
    7. 負担が偏らないよう、上限に対する勤務時間の割合が低い人から優先
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ShiftEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAYS = ["月", "火", "水", "木", "金", "土", "日"];
  var SLOTS = [
    { id: "m", label: "朝", time: "7:00〜11:00", hours: 4, early: true },
    { id: "l", label: "昼", time: "11:00〜15:00", hours: 4, peak: true },
    { id: "d", label: "夜", time: "17:00〜21:00", hours: 4 }
  ];
  var SLOT_INDEX = { m: 0, l: 1, d: 2 };
  var WEEKEND = { 5: true, 6: true };
  var MAX_SLOTS_PER_DAY = 2;

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  // その月の日付一覧。dow は 月=0 … 日=6
  function monthDays(year, month) {
    var n = new Date(year, month, 0).getDate(), out = [];
    for (var d = 1; d <= n; d++) {
      out.push({ key: year + "-" + pad(month) + "-" + pad(d), dom: d, dow: (new Date(year, month - 1, d).getDay() + 6) % 7 });
    }
    return out;
  }

  function patIndex(dow, slotId) { return dow * 3 + SLOT_INDEX[slotId]; }
  // いつもの出られる時間帯（曜日×枠）
  function inPattern(person, dow, slotId) {
    return (person.pattern || "").charAt(patIndex(dow, slotId)) === "1";
  }
  function isBusy(person, dayKey) { return (person.busy || []).indexOf(dayKey) >= 0; }
  // その日・その枠に出られるか（いつもの時間帯 かつ 予定あり日でない）
  function isAvailable(person, day, slotId) {
    return inPattern(person, day.dow, slotId) && !isBusy(person, day.key);
  }
  function slotById(id) { return SLOTS[SLOT_INDEX[id]]; }

  function basicEligible(person, store, day, slotId) {
    if (!isAvailable(person, day, slotId)) return false;
    if (person.stores.indexOf(store.id) < 0) return false;
    if (slotId === "m" && !person.early) return false;
    return true;
  }

  function emptySchedule(stores, days) {
    var assign = {};
    stores.forEach(function (s) {
      assign[s.id] = {};
      days.forEach(function (day) {
        assign[s.id][day.key] = {};
        SLOTS.forEach(function (sl) { assign[s.id][day.key][sl.id] = []; });
      });
    });
    return assign;
  }

  function storeHasSlot(store, day, slotId) {
    if (store.closedDay === day.dow) return false;
    if (slotId === "m" && !store.hasMorning) return false;
    return (store.need[slotId] || 0) > 0;
  }

  function dayLoad(assign, stores, personId, dayKey) {
    var count = 0, slotsTaken = {};
    stores.forEach(function (s) {
      SLOTS.forEach(function (sl) {
        var cell = assign[s.id][dayKey] && assign[s.id][dayKey][sl.id];
        if (cell && cell.indexOf(personId) >= 0) { count++; slotsTaken[sl.id] = true; }
      });
    });
    return { count: count, slots: slotsTaken };
  }

  function computeHours(assign, stores, staff, days) {
    var hours = {};
    staff.forEach(function (p) { hours[p.id] = 0; });
    stores.forEach(function (s) {
      days.forEach(function (day) {
        SLOTS.forEach(function (sl) {
          assign[s.id][day.key][sl.id].forEach(function (pid) {
            if (hours[pid] !== undefined) hours[pid] += sl.hours;
          });
        });
      });
    });
    return hours;
  }

  function canAssign(assign, stores, person, store, day, slotId, hours) {
    if (!basicEligible(person, store, day, slotId)) return false;
    var sl = slotById(slotId);
    if (hours[person.id] + sl.hours > person.cap) return false;
    var load = dayLoad(assign, stores, person.id, day.key);
    if (load.slots[slotId]) return false;
    if (load.count >= MAX_SLOTS_PER_DAY) return false;
    return true;
  }

  function priority(person, day, slotId, hours) {
    var ratio = person.cap > 0 ? hours[person.id] / person.cap : 1;
    if (person.type === "学生" && WEEKEND[day.dow] && slotId === "l") ratio -= 0.5;
    return ratio;
  }

  function pickBest(cands, day, slotId, hours) {
    cands.sort(function (a, b) {
      var pa = priority(a, day, slotId, hours), pb = priority(b, day, slotId, hours);
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : 1;
    });
    return cands[0] || null;
  }

  function findPerson(staff, id) {
    for (var i = 0; i < staff.length; i++) if (staff[i].id === id) return staff[i];
    return null;
  }

  function generate(stores, staff, days) {
    var assign = emptySchedule(stores, days);
    var hours = {};
    staff.forEach(function (p) { hours[p.id] = 0; });

    var needs = [];
    stores.forEach(function (s) {
      days.forEach(function (day) {
        SLOTS.forEach(function (sl) {
          if (!storeHasSlot(s, day, sl.id)) return;
          var pool = staff.filter(function (p) { return basicEligible(p, s, day, sl.id); });
          var vets = pool.filter(function (p) { return p.veteran; });
          needs.push({ store: s, day: day, slot: sl.id, need: s.need[sl.id], poolSize: pool.length, vetSize: vets.length });
        });
      });
    });

    // 1周目：各枠にベテランを1人ずつ（ベテランが少ない枠から）
    needs.slice().sort(function (a, b) {
      if (a.vetSize !== b.vetSize) return a.vetSize - b.vetSize;
      return a.poolSize - b.poolSize;
    }).forEach(function (n) {
      var cands = staff.filter(function (p) {
        return p.veteran && canAssign(assign, stores, p, n.store, n.day, n.slot, hours);
      });
      var best = pickBest(cands, n.day, n.slot, hours);
      if (best) {
        assign[n.store.id][n.day.key][n.slot].push(best.id);
        hours[best.id] += slotById(n.slot).hours;
      }
    });

    // 2周目：残りの人数を埋める（出られる人が少ない枠から）
    needs.slice().sort(function (a, b) { return a.poolSize - b.poolSize; }).forEach(function (n) {
      var cell = assign[n.store.id][n.day.key][n.slot];
      while (cell.length < n.need) {
        var hasVet = cell.some(function (pid) { return findPerson(staff, pid).veteran; });
        var cands = staff.filter(function (p) {
          if (cell.indexOf(p.id) >= 0) return false;
          if (!hasVet && !p.veteran) return false;
          return canAssign(assign, stores, p, n.store, n.day, n.slot, hours);
        });
        var best = pickBest(cands, n.day, n.slot, hours);
        if (!best) break;
        cell.push(best.id);
        hours[best.id] += slotById(n.slot).hours;
      }
    });

    return { assign: assign, hours: hours, issues: findIssues(assign, stores, staff, days) };
  }

  function findIssues(assign, stores, staff, days) {
    var shortages = [], noVeteran = [], violations = [];
    var hours = computeHours(assign, stores, staff, days);
    stores.forEach(function (s) {
      days.forEach(function (day) {
        SLOTS.forEach(function (sl) {
          var cell = assign[s.id][day.key][sl.id];
          if (!storeHasSlot(s, day, sl.id)) {
            if (cell.length) violations.push({ store: s.id, day: day.key, slot: sl.id, msg: "営業していない枠に人が入っています" });
            return;
          }
          var need = s.need[sl.id];
          if (cell.length < need) shortages.push({ store: s.id, day: day.key, slot: sl.id, missing: need - cell.length });
          if (!cell.some(function (pid) { var p = findPerson(staff, pid); return p && p.veteran; })) {
            noVeteran.push({ store: s.id, day: day.key, slot: sl.id });
          }
          cell.forEach(function (pid) {
            var p = findPerson(staff, pid);
            if (!p) return;
            if (!basicEligible(p, s, day, sl.id)) violations.push({ store: s.id, day: day.key, slot: sl.id, msg: p.name + "さんの希望・条件に合わない枠です" });
          });
        });
      });
    });
    staff.forEach(function (p) {
      if (hours[p.id] > p.cap) violations.push({ msg: p.name + "さんが月の上限（" + p.cap + "時間）を超えています" });
      days.forEach(function (day) {
        var load = dayLoad(assign, stores, p.id, day.key);
        if (load.count > MAX_SLOTS_PER_DAY) violations.push({ msg: p.name + "さんが" + day.key + "に" + load.count + "枠入っています" });
        var perSlot = {};
        stores.forEach(function (s) {
          SLOTS.forEach(function (sl) {
            if (assign[s.id][day.key][sl.id].indexOf(p.id) >= 0) perSlot[sl.id] = (perSlot[sl.id] || 0) + 1;
          });
        });
        Object.keys(perSlot).forEach(function (k) {
          if (perSlot[k] > 1) violations.push({ msg: p.name + "さんが" + day.key + "の同じ時間に2店舗かけもちになっています" });
        });
      });
    });
    return { shortages: shortages, noVeteran: noVeteran, violations: violations, hours: hours };
  }

  // 急な欠勤のときの代役候補。休む人がその枠の唯一のベテランなら、ベテランだけを候補にする
  function substitutes(assign, stores, staff, days, storeId, dayKey, slotId, absentId) {
    var store = stores.filter(function (s) { return s.id === storeId; })[0];
    var day = days.filter(function (d) { return d.key === dayKey; })[0];
    var cell = assign[storeId][dayKey][slotId];
    var others = cell.filter(function (pid) { return pid !== absentId; });
    var stillHasVet = others.some(function (pid) { var p = findPerson(staff, pid); return p && p.veteran; });
    var trial = JSON.parse(JSON.stringify(assign));
    trial[storeId][dayKey][slotId] = others;
    var hours = computeHours(trial, stores, staff, days);
    var list = staff.filter(function (p) {
      if (p.id === absentId || others.indexOf(p.id) >= 0) return false;
      if (!stillHasVet && !p.veteran) return false;
      return canAssign(trial, stores, p, store, day, slotId, hours);
    }).map(function (p) {
      return { person: p, hours: hours[p.id], ratio: p.cap ? hours[p.id] / p.cap : 1 };
    });
    list.sort(function (a, b) { return a.ratio - b.ratio; });
    return { mustBeVeteran: !stillHasVet, candidates: list };
  }

  // ---- サンプルデータ（架空の店舗・スタッフ）----
  function patFrom(spec) {
    var bits = [];
    for (var d = 0; d < 7; d++) {
      SLOTS.forEach(function (sl) { bits.push((spec[sl.id] || []).indexOf(d) >= 0 ? "1" : "0"); });
    }
    return bits.join("");
  }
  var ALL = [0, 1, 2, 3, 4, 5, 6], WEEKDAYS = [0, 1, 2, 3, 4], WKND = [5, 6];

  function sampleStores() {
    return [
      { id: "A", name: "本店", closedDay: 2, hasMorning: true, need: { m: 1, l: 2, d: 1 } },
      { id: "B", name: "駅前店", closedDay: 1, hasMorning: false, need: { m: 0, l: 2, d: 1 } },
      { id: "C", name: "バイパス店", closedDay: 3, hasMorning: false, need: { m: 0, l: 2, d: 1 } }
    ];
  }

  // cap は「月の上限時間」。pattern は「いつもの出られる時間帯」。
  function sampleStaff() {
    return [
      { id: "s01", name: "佐藤", type: "正社員", veteran: true, stores: ["A", "B"], early: true, cap: 160, pattern: patFrom({ m: ALL, l: ALL, d: ALL }), busy: [] },
      { id: "s02", name: "鈴木", type: "正社員", veteran: true, stores: ["B", "C"], early: false, cap: 160, pattern: patFrom({ l: ALL, d: ALL }), busy: [] },
      { id: "s03", name: "高橋", type: "正社員", veteran: true, stores: ["A", "C"], early: true, cap: 160, pattern: patFrom({ m: ALL, l: ALL, d: ALL }), busy: [] },
      { id: "s04", name: "田中", type: "主婦パート", veteran: true, stores: ["A"], early: true, cap: 80, pattern: patFrom({ m: WEEKDAYS, l: WEEKDAYS }), busy: [] },
      { id: "s05", name: "伊藤", type: "主婦パート", veteran: true, stores: ["B"], early: false, cap: 80, pattern: patFrom({ l: WEEKDAYS }), busy: [] },
      { id: "s06", name: "渡辺", type: "主婦パート", veteran: false, stores: ["C"], early: false, cap: 80, pattern: patFrom({ l: WEEKDAYS }), busy: [] },
      { id: "s07", name: "山本", type: "学生", veteran: true, stores: ["A", "B"], early: false, cap: 80, pattern: patFrom({ l: WKND, d: ALL }), busy: [] },
      { id: "s08", name: "中村", type: "学生", veteran: false, stores: ["B", "C"], early: false, cap: 80, pattern: patFrom({ l: WKND, d: ALL }), busy: [] },
      { id: "s09", name: "小林", type: "学生", veteran: false, stores: ["A", "C"], early: false, cap: 80, pattern: patFrom({ l: WKND, d: ALL }), busy: [] },
      { id: "s10", name: "加藤", type: "フリーター", veteran: true, stores: ["A", "B", "C"], early: false, cap: 128, pattern: patFrom({ l: ALL, d: ALL }), busy: [] },
      { id: "s11", name: "吉田", type: "パート", veteran: false, stores: ["A", "B"], early: true, cap: 112, pattern: patFrom({ m: ALL, l: ALL }), busy: [] },
      { id: "s12", name: "山田", type: "パート", veteran: true, stores: ["C"], early: false, cap: 112, pattern: patFrom({ l: ALL, d: ALL }), busy: [] }
    ];
  }

  // デモ用：決まった「予定あり日」を各スタッフに入れる（毎回同じ結果になる擬似乱数）
  function seedBusy(staff, days) {
    staff.forEach(function (p, i) {
      var seed = 7919 * (i + 3), n = (p.type === "学生" ? 8 : p.type === "正社員" ? 4 : 6);
      var picks = [];
      for (var k = 0; k < n; k++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        var key = days[seed % days.length].key;
        if (picks.indexOf(key) < 0) picks.push(key);
      }
      p.busy = picks.sort();
    });
    return staff;
  }

  return {
    DAYS: DAYS, SLOTS: SLOTS,
    monthDays: monthDays, patIndex: patIndex, inPattern: inPattern, isBusy: isBusy, isAvailable: isAvailable,
    storeHasSlot: storeHasSlot,
    generate: generate, findIssues: findIssues, computeHours: computeHours, substitutes: substitutes,
    sampleStores: sampleStores, sampleStaff: sampleStaff, seedBusy: seedBusy
  };
});
