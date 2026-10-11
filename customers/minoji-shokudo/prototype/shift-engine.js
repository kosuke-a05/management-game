/*
  美濃路食堂 シフト自動作成エンジン（お試し版）
  - ブラウザでは window.ShiftEngine、Node では require() で使える
  - 清水さんのルール：
    1. 各枠に最低1人ベテラン（新人だけの時間帯を作らない。昼ピークは特に必須）
    2. 学生は土日の昼を優先して入れる
    3. 週の上限時間（扶養内など）を超えない
    4. 朝（7:00〜）は本店のみ。早朝に出られる人だけ
    5. 本人の希望（出られる枠）以外には入れない
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

  function availIndex(day, slotId) { return day * 3 + SLOT_INDEX[slotId]; }
  function isAvailable(person, day, slotId) {
    return (person.avail || "").charAt(availIndex(day, slotId)) === "1";
  }
  function slotById(id) { return SLOTS[SLOT_INDEX[id]]; }

  // 本人の希望・店舗・早朝の条件だけを見た「出られるかどうか」（時間上限は別判定）
  function basicEligible(person, store, day, slotId) {
    if (!isAvailable(person, day, slotId)) return false;
    if (person.stores.indexOf(store.id) < 0) return false;
    if (slotId === "m" && !person.early) return false;
    return true;
  }

  function emptySchedule(stores) {
    var assign = {};
    stores.forEach(function (s) {
      assign[s.id] = {};
      for (var d = 0; d < 7; d++) {
        assign[s.id][d] = {};
        SLOTS.forEach(function (sl) { assign[s.id][d][sl.id] = []; });
      }
    });
    return assign;
  }

  function storeHasSlot(store, day, slotId) {
    if (store.closedDay === day) return false;
    if (slotId === "m" && !store.hasMorning) return false;
    return (store.need[slotId] || 0) > 0;
  }

  // その人が、その日・その枠にすでにどこかの店で入っているか / その日何枠入っているか
  function dayLoad(assign, stores, personId, day) {
    var count = 0, slotsTaken = {};
    stores.forEach(function (s) {
      SLOTS.forEach(function (sl) {
        if (assign[s.id][day][sl.id].indexOf(personId) >= 0) { count++; slotsTaken[sl.id] = true; }
      });
    });
    return { count: count, slots: slotsTaken };
  }

  function computeHours(assign, stores, staff) {
    var hours = {};
    staff.forEach(function (p) { hours[p.id] = 0; });
    stores.forEach(function (s) {
      for (var d = 0; d < 7; d++) {
        SLOTS.forEach(function (sl) {
          assign[s.id][d][sl.id].forEach(function (pid) {
            if (hours[pid] !== undefined) hours[pid] += sl.hours;
          });
        });
      }
    });
    return hours;
  }

  // 時間上限・かけもち・1日の枠数まで含めて、今この人を入れられるか
  function canAssign(assign, stores, person, store, day, slotId, hours) {
    if (!basicEligible(person, store, day, slotId)) return false;
    var sl = slotById(slotId);
    if (hours[person.id] + sl.hours > person.cap) return false;
    var load = dayLoad(assign, stores, person.id, day);
    if (load.slots[slotId]) return false;
    if (load.count >= MAX_SLOTS_PER_DAY) return false;
    return true;
  }

  // 優先度：上限に対する勤務割合が低い人ほど先（負担の偏りを防ぐ）。学生は土日の昼を優先。
  function priority(person, day, slotId, hours) {
    var ratio = person.cap > 0 ? hours[person.id] / person.cap : 1;
    if (person.type === "学生" && WEEKEND[day] && slotId === "l") ratio -= 0.5;
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

  function generate(stores, staff) {
    var assign = emptySchedule(stores);
    var hours = {};
    staff.forEach(function (p) { hours[p.id] = 0; });

    // 埋める必要のある枠の一覧。出られる人が少ない枠（埋めにくい枠）から順に処理する
    var needs = [];
    stores.forEach(function (s) {
      for (var d = 0; d < 7; d++) {
        SLOTS.forEach(function (sl) {
          if (!storeHasSlot(s, d, sl.id)) return;
          var pool = staff.filter(function (p) { return basicEligible(p, s, d, sl.id); });
          var vets = pool.filter(function (p) { return p.veteran; });
          needs.push({ store: s, day: d, slot: sl.id, need: s.need[sl.id], poolSize: pool.length, vetSize: vets.length });
        });
      }
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
        assign[n.store.id][n.day][n.slot].push(best.id);
        hours[best.id] += slotById(n.slot).hours;
      }
    });

    // 2周目：残りの人数を埋める（出られる人が少ない枠から）
    needs.slice().sort(function (a, b) { return a.poolSize - b.poolSize; }).forEach(function (n) {
      var cell = assign[n.store.id][n.day][n.slot];
      while (cell.length < n.need) {
        var hasVet = cell.some(function (pid) { return findPerson(staff, pid).veteran; });
        var cands = staff.filter(function (p) {
          if (cell.indexOf(p.id) >= 0) return false;
          // ベテランがまだいない枠に新人だけを入れない
          if (!hasVet && !p.veteran) return false;
          return canAssign(assign, stores, p, n.store, n.day, n.slot, hours);
        });
        var best = pickBest(cands, n.day, n.slot, hours);
        if (!best) break;
        cell.push(best.id);
        hours[best.id] += slotById(n.slot).hours;
      }
    });

    return { assign: assign, hours: hours, issues: findIssues(assign, stores, staff) };
  }

  function findPerson(staff, id) {
    for (var i = 0; i < staff.length; i++) if (staff[i].id === id) return staff[i];
    return null;
  }

  // 人手不足・ベテラン不在（＝清水さんの判断が必要な枠）と、ルール違反（本来ゼロであるべき）を洗い出す
  function findIssues(assign, stores, staff) {
    var shortages = [], noVeteran = [], violations = [];
    var hours = computeHours(assign, stores, staff);
    stores.forEach(function (s) {
      for (var d = 0; d < 7; d++) {
        SLOTS.forEach(function (sl) {
          var cell = assign[s.id][d][sl.id];
          if (!storeHasSlot(s, d, sl.id)) {
            if (cell.length) violations.push({ store: s.id, day: d, slot: sl.id, msg: "営業していない枠に人が入っています" });
            return;
          }
          var need = s.need[sl.id];
          if (cell.length < need) shortages.push({ store: s.id, day: d, slot: sl.id, missing: need - cell.length });
          if (!cell.some(function (pid) { var p = findPerson(staff, pid); return p && p.veteran; })) {
            noVeteran.push({ store: s.id, day: d, slot: sl.id });
          }
          cell.forEach(function (pid) {
            var p = findPerson(staff, pid);
            if (!p) return;
            if (!basicEligible(p, s, d, sl.id)) violations.push({ store: s.id, day: d, slot: sl.id, msg: p.name + "さんの希望・条件に合わない枠です" });
          });
        });
      }
    });
    staff.forEach(function (p) {
      if (hours[p.id] > p.cap) violations.push({ msg: p.name + "さんが週の上限（" + p.cap + "時間）を超えています" });
      for (var d = 0; d < 7; d++) {
        var load = dayLoad(assign, stores, p.id, d);
        if (load.count > MAX_SLOTS_PER_DAY) violations.push({ msg: p.name + "さんが" + DAYS[d] + "曜に" + load.count + "枠入っています" });
        var perSlot = {};
        stores.forEach(function (s) {
          SLOTS.forEach(function (sl) {
            if (assign[s.id][d][sl.id].indexOf(p.id) >= 0) perSlot[sl.id] = (perSlot[sl.id] || 0) + 1;
          });
        });
        Object.keys(perSlot).forEach(function (k) {
          if (perSlot[k] > 1) violations.push({ msg: p.name + "さんが" + DAYS[d] + "曜の同じ時間に2店舗かけもちになっています" });
        });
      }
    });
    return { shortages: shortages, noVeteran: noVeteran, violations: violations, hours: hours };
  }

  // 急な欠勤のときの代役候補。休む人がその枠の唯一のベテランなら、ベテランだけを候補にする
  function substitutes(assign, stores, staff, storeId, day, slotId, absentId) {
    var store = stores.filter(function (s) { return s.id === storeId; })[0];
    var cell = assign[storeId][day][slotId];
    var others = cell.filter(function (pid) { return pid !== absentId; });
    var stillHasVet = others.some(function (pid) { var p = findPerson(staff, pid); return p && p.veteran; });
    // 休む人の分の時間を引いた状態で計算する
    var trial = JSON.parse(JSON.stringify(assign));
    trial[storeId][day][slotId] = others;
    var hours = computeHours(trial, stores, staff);
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
  function availFrom(spec) {
    // spec: { m: [曜日index...], l: [...], d: [...] }
    var bits = [];
    for (var d = 0; d < 7; d++) {
      SLOTS.forEach(function (sl) { bits.push((spec[sl.id] || []).indexOf(d) >= 0 ? "1" : "0"); });
    }
    return bits.join("");
  }
  var ALL = [0, 1, 2, 3, 4, 5, 6], WEEKDAYS = [0, 1, 2, 3, 4], WKND = [5, 6];
  function without(arr, x) { return arr.filter(function (v) { return x.indexOf(v) < 0; }); }

  function sampleStores() {
    return [
      { id: "A", name: "本店", closedDay: 2, hasMorning: true, need: { m: 1, l: 2, d: 1 } },
      { id: "B", name: "駅前店", closedDay: 1, hasMorning: false, need: { m: 0, l: 2, d: 1 } },
      { id: "C", name: "バイパス店", closedDay: 3, hasMorning: false, need: { m: 0, l: 2, d: 1 } }
    ];
  }

  function sampleStaff() {
    return [
      { id: "s01", name: "佐藤", type: "正社員", veteran: true, stores: ["A", "B"], early: true, cap: 40, avail: availFrom({ m: without(ALL, [6]), l: without(ALL, [6]), d: without(ALL, [6]) }) },
      { id: "s02", name: "鈴木", type: "正社員", veteran: true, stores: ["B", "C"], early: false, cap: 40, avail: availFrom({ l: without(ALL, [0]), d: without(ALL, [0]) }) },
      { id: "s03", name: "高橋", type: "正社員", veteran: true, stores: ["A", "C"], early: true, cap: 40, avail: availFrom({ m: without(ALL, [5]), l: without(ALL, [5]), d: without(ALL, [5]) }) },
      { id: "s04", name: "田中", type: "主婦パート", veteran: true, stores: ["A"], early: true, cap: 20, avail: availFrom({ m: WEEKDAYS, l: WEEKDAYS }) },
      { id: "s05", name: "伊藤", type: "主婦パート", veteran: true, stores: ["B"], early: false, cap: 20, avail: availFrom({ l: WEEKDAYS }) },
      { id: "s06", name: "渡辺", type: "主婦パート", veteran: false, stores: ["C"], early: false, cap: 20, avail: availFrom({ l: WEEKDAYS }) },
      { id: "s07", name: "山本", type: "学生", veteran: true, stores: ["A", "B"], early: false, cap: 20, avail: availFrom({ l: WKND, d: [1, 3, 5, 6] }) },
      { id: "s08", name: "中村", type: "学生", veteran: false, stores: ["B", "C"], early: false, cap: 20, avail: availFrom({ l: WKND, d: [0, 2, 4, 5, 6] }) },
      { id: "s09", name: "小林", type: "学生", veteran: false, stores: ["A", "C"], early: false, cap: 20, avail: availFrom({ l: WKND, d: [1, 2, 4, 6] }) },
      { id: "s10", name: "加藤", type: "フリーター", veteran: true, stores: ["A", "B", "C"], early: false, cap: 32, avail: availFrom({ l: without(ALL, [2]), d: without(ALL, [2]) }) },
      { id: "s11", name: "吉田", type: "パート", veteran: false, stores: ["A", "B"], early: true, cap: 28, avail: availFrom({ m: without(ALL, [6]), l: without(ALL, [6]) }) },
      { id: "s12", name: "山田", type: "パート", veteran: true, stores: ["C"], early: false, cap: 28, avail: availFrom({ l: WKND, d: ALL }) }
    ];
  }

  return {
    DAYS: DAYS, SLOTS: SLOTS,
    isAvailable: isAvailable, availIndex: availIndex, storeHasSlot: storeHasSlot,
    generate: generate, findIssues: findIssues, computeHours: computeHours, substitutes: substitutes,
    sampleStores: sampleStores, sampleStaff: sampleStaff
  };
});
