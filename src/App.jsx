import { useState, useEffect, useMemo } from "react";
import emailjs from "@emailjs/browser";
import JSZip from "jszip";
import { subscribeApplications } from "./storage.js";
import {
  Calendar, User, Mail, Phone, CheckCircle2, AlertCircle, Info,
  Lock, ShieldCheck, RotateCcw, X, Loader2, Download, Search,
} from "lucide-react";

const DAYS = [
  { key: "10-15", short: "10.15", dow: "THU", kr: "10월 15일 (목)", en: "Oct 15 (Thu)", agenda: "Thursday 15.10" },
  { key: "10-16", short: "10.16", dow: "FRI", kr: "10월 16일 (금)", en: "Oct 16 (Fri)", agenda: "Friday 16.10" },
  { key: "10-17", short: "10.17", dow: "SAT", kr: "10월 17일 (토)", en: "Oct 17 (Sat)", agenda: "Saturday 17.10" },
  { key: "10-18", short: "10.18", dow: "SUN", kr: "10월 18일 (일)", en: "Oct 18 (Sun)", agenda: "Sunday 18.10" },
];

const DAY_START = 9 * 60;
const DAY_END = 17 * 60 + 45;
const SESSION_LEN = 45;
const GAP = 15;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}
function buildFineSlots() {
  const slots = [];
  for (let t = DAY_START; t <= DAY_END; t += 15) slots.push(toHHMM(t));
  return slots;
}
const FINE_SLOTS = buildFineSlots();
const STANDARD_START_TIMES = ["10:30", "11:30", "13:00", "14:00", "15:00", "16:00", "17:00"];

function nearestStandardStart(min) {
  let best = STANDARD_START_TIMES[0];
  let bestDiff = Infinity;
  for (const t of STANDARD_START_TIMES) {
    const diff = Math.abs(toMinutes(t) - min);
    if (diff < bestDiff) { bestDiff = diff; best = t; }
  }
  return best;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
function activeApps(apps) {
  return apps.filter((a) => a.status !== "rejected" && a.status !== "canceled");
}
function findConflict(apps, day, startMin, endMin, excludeId, gap = GAP) {
  return activeApps(apps).find((a) => {
    if (a.day !== day) return false;
    if (a.id === excludeId) return false;
    const aStart = toMinutes(a.startTime);
    const aEnd = aStart + a.duration;
    return overlaps(aStart - gap, aEnd + gap, startMin, endMin);
  });
}
function pct(min) {
  return ((min - DAY_START) / (DAY_END - DAY_START)) * 100;
}
function buildHourTicks() {
  const ticks = [];
  for (let h = 9; h <= 17; h++) ticks.push(h * 60);
  ticks.push(DAY_END);
  return ticks;
}
const HOUR_TICKS = buildHourTicks();
const SKIP_LABEL = new Set(HOUR_TICKS.filter((t) => t !== DAY_END && DAY_END - t < 45));

function tickLabel(min) {
  const h = Math.floor(min / 60).toString().padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function computeDayBlocks(apps, dayKey) {
  const dayApps = activeApps(apps)
    .filter((a) => a.day === dayKey)
    .map((a) => ({ app: a, startMin: toMinutes(a.startTime), endMin: toMinutes(a.startTime) + a.duration }))
    .sort((a, b) => a.startMin - b.startMin);
  const blocks = [];
  let cursor = DAY_START;
  for (const a of dayApps) {
    if (a.startMin > cursor) blocks.push({ startMin: cursor, endMin: a.startMin, status: "empty" });
    blocks.push({ startMin: a.startMin, endMin: a.endMin, status: a.app.status, app: a.app });
    cursor = Math.max(cursor, a.endMin);
  }
  if (cursor < DAY_END) blocks.push({ startMin: cursor, endMin: DAY_END, status: "empty" });
  return blocks;
}

function refCode(id) {
  return "VB2026-" + id.slice(-5).toUpperCase();
}

const DEFAULT_ACCESS_CODE = "vietbaby2026";

const EMAILJS_SERVICE_ID = import.meta.env.VITE_EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = import.meta.env.VITE_EMAILJS_TEMPLATE_ID;
const EMAILJS_ADMIN_TEMPLATE_ID = import.meta.env.VITE_EMAILJS_ADMIN_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = import.meta.env.VITE_EMAILJS_PUBLIC_KEY;
const ORGANIZER_NOTIFY_EMAIL = import.meta.env.VITE_ORGANIZER_NOTIFY_EMAIL || "overseas.segefairs@gmail.com";
const APPLICATION_DEADLINE = new Date("2026-09-14T23:59:59+07:00");
const STALE_PENDING_DAYS = 3;

async function sendStatusEmail(app, status) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) return;
  if (!app.picEmail) return;
  const dayLabel = DAYS.find((d) => d.key === app.day);
  try {
    await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      {
        to_email: app.picEmail,
        to_name: app.picName || app.companyName,
        company_name: app.companyName,
        session_title: app.sessionTitle,
        status_kr: status === "confirmed" ? "확정" : status === "rejected" ? "반려" : status === "canceled" ? "취소" : "검토중",
        status_en: status === "confirmed" ? "Confirmed" : status === "rejected" ? "Rejected" : status === "canceled" ? "Canceled" : "Pending",
        ref_code: refCode(app.id),
        day_label: dayLabel ? dayLabel.kr : app.day,
        start_time: app.startTime,
        end_time: toHHMM(toMinutes(app.startTime) + app.duration),
      },
      { publicKey: EMAILJS_PUBLIC_KEY }
    );
  } catch (e) {
    console.error("email send failed", e);
  }
}

async function sendNewApplicationAlert(app) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_ADMIN_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) return;
  const dayLabel = DAYS.find((d) => d.key === app.day);
  try {
    await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_ADMIN_TEMPLATE_ID,
      {
        to_email: ORGANIZER_NOTIFY_EMAIL,
        company_name: app.companyName,
        booth_no: app.boothNo,
        session_title: app.sessionTitle,
        pic_name: app.picName,
        pic_email: app.picEmail,
        pic_phone: app.picPhone,
        track_label: TRACKS[app.track] ? `${TRACKS[app.track].kr} / ${TRACKS[app.track].en}` : "-",
        day_label: dayLabel ? dayLabel.kr : app.day,
        start_time: app.startTime,
        end_time: toHHMM(toMinutes(app.startTime) + app.duration),
      },
      { publicKey: EMAILJS_PUBLIC_KEY }
    );
  } catch (e) {
    console.error("admin alert email failed", e);
  }
}

const DEFAULT_BLOCKS = [
  { day: "10-15", startTime: "09:00", duration: 45 },
  { day: "10-17", startTime: "09:00", duration: 45 },
  { day: "10-18", startTime: "09:00", duration: 45 },
  { day: "10-15", startTime: "12:00", duration: 60 },
  { day: "10-17", startTime: "12:00", duration: 60 },
  { day: "10-18", startTime: "12:00", duration: 60 },
];

function makeBlockedRecord(day, startTime, duration) {
  return {
    id: `seed-${day}-${startTime}`, day, startTime, duration, track: "",
    sessionTitle: "이용 불가 Unavailable", companyName: "",
    sessionDescription: "", picName: "", picPosition: "", phoneCountry: "kr", picPhone: "", picEmail: "",
    boothNo: "", companyLogo: "",
    status: "confirmed", isSpecial: true, isBlocked: true, submittedAt: new Date(0).toISOString(),
  };
}

function dayItemsFor(apps, dayKey, confirmedOnly) {
  return activeApps(apps)
    .filter((a) => a.day === dayKey && !a.isBlocked && (!confirmedOnly || a.status === "confirmed"))
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
}

function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function logoExtension(dataUrl) {
  const match = /^data:image\/(\w+);/.exec(dataUrl || "");
  return match ? match[1].replace("jpeg", "jpg") : "png";
}

async function downloadAllLogosZip(apps) {
  const withLogo = (apps || []).filter((a) => a.companyLogo);
  if (withLogo.length === 0) return 0;
  const zip = new JSZip();
  withLogo.forEach((a, i) => {
    const base64 = (a.companyLogo.split(",")[1] || "");
    const filename = `${(a.companyName || "logo").replace(/[^\w.-]+/g, "_")}_${i + 1}.${logoExtension(a.companyLogo)}`;
    zip.file(filename, base64, { base64: true });
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "vietbaby_vietedu_logos.zip";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return withLogo.length;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exportScheduleXlsx(apps, confirmedOnly) {
  const rows = [];
  rows.push(
    `<tr><td colspan="3" style="font-weight:bold;font-size:16pt;text-align:center;padding:10px;">STAGE SCHEDULE VIETBABY &amp; VIETEDU HANOI 2026</td></tr>`
  );
  rows.push(
    `<tr>` +
      `<td style="background:#D9E8CB;font-weight:bold;text-align:center;">HOUR</td>` +
      `<td style="background:#D9E8CB;font-weight:bold;text-align:center;">ACTIVITIES</td>` +
      `<td style="background:#D9E8CB;font-weight:bold;text-align:center;">ORGANIZED BY</td>` +
      `</tr>`
  );

  DAYS.forEach((d) => {
    rows.push(
      `<tr><td colspan="3" style="background:#F1B9B5;font-weight:bold;text-align:center;">${escapeHtml(d.agenda)}</td></tr>`
    );
    const items = dayItemsFor(apps, d.key, confirmedOnly);
    if (items.length === 0) {
      rows.push(`<tr><td style="text-align:center;">-</td><td style="text-align:center;">-</td><td style="text-align:center;">-</td></tr>`);
    } else {
      items.forEach((a) => {
        const range = `${a.startTime} - ${toHHMM(toMinutes(a.startTime) + a.duration)}`;
        rows.push(
          `<tr><td>${escapeHtml(range)}</td><td>${escapeHtml(a.sessionTitle)}</td><td>${escapeHtml(a.companyName)}</td></tr>`
        );
      });
    }
  });

  const html =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="UTF-8">` +
    `<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>` +
    `<x:Name>Stage Schedule</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>` +
    `</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->` +
    `<style>table{border-collapse:collapse;font-family:Calibri,Arial,sans-serif;} td{border:1px solid #999999;padding:6px 10px;font-size:11pt;}</style>` +
    `</head><body><table>` +
    `<colgroup><col style="width:110px"><col style="width:420px"><col style="width:220px"></colgroup>` +
    rows.join("") +
    `</table></body></html>`;

  const blob = new Blob(["\ufeff" + html], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "vietbaby_vietedu_stage_schedule.xls";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function loadFonts() {
  if (document.getElementById("vb-fonts")) return;
  const link = document.createElement("link");
  link.id = "vb-fonts";
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
  document.head.appendChild(link);
}

const INK = "#141414";
const MUTED = "#54504A";
const PAPER = "#FFFFFF";
const PAPER_2 = "#E7ECF5";
const BORDER = "#C3CCDA";
const GOLD = "#C7963B";
const GOLD_DARK = "#8C6A25";
const NOTICE_BORDER = "#AEBEDA";
const NOTICE_ICON = "#3E5C82";
const LACQUER = "#A32B2E";
const LACQUER_DARK = "#7A2022";
const LACQUER_LIGHT = "#F4D9D6";
const BLUE = "#2E5FA3";
const BLUE_DARK = "#1F3F6E";
const BLUE_LIGHT = "#D3E8FB";
const SANS =
  "'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', monospace";

const TRACKS = {
  vietbaby: { key: "vietbaby", kr: "베이비페어", en: "VIETBABY · Baby Fair", strong: LACQUER, light: LACQUER_LIGHT, text: LACQUER_DARK },
  vietedu: { key: "vietedu", kr: "교육박람회", en: "Education Fair", strong: BLUE, light: BLUE_LIGHT, text: BLUE_DARK },
};

const CONTACTS = [
  { kr: "한국 참가사 문의처", en: "Korea Exhibitor Contact", org: "세계전람 SEGE Fairs", phone: "02-3453-2118", email: "overseas.segefairs@gmail.com" },
  { kr: "", en: "Vietnam Exhibitor Contact", org: "Coex Vina", phone: "84-901-534-565", email: "minhkhue@coex.vn" },
];

const COUNTRY_CODES = {
  kr: { code: "+82", kr: "대한민국", en: "South Korea" },
  vn: { code: "+84", kr: "베트남", en: "Vietnam" },
};

function formatPhoneDigits(country, digits) {
  const d = digits.slice(0, 11);
  if (country === "kr") {
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 11)}`;
  }
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

const styles = {
  page: { fontFamily: SANS, background: PAPER, color: INK, minHeight: "100%", lineHeight: 1.6 },
  mono: { fontFamily: MONO },
};

function ContactCard({ c }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "#F1F4F9", border: `1px solid ${BORDER}`, borderRadius: 4, padding: "10px 12px" }}>
      <Phone size={14} color={LACQUER} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
      <div>
        <div style={{ fontWeight: 600, fontSize: 12.5, color: INK }}>{c.kr ? `${c.kr} · ${c.en}` : c.en}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{c.org} · {c.phone} · {c.email}</div>
      </div>
    </div>
  );
}

function NoticeItem({ n, kr, en }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ ...styles.mono, fontSize: 11, color: NOTICE_ICON, border: `1px solid ${NOTICE_ICON}`, borderRadius: "50%", width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
        {n}
      </span>
      <div style={{ lineHeight: 1.7 }}>
        <div style={{ color: INK }}>{kr}</div>
        <div style={{ color: MUTED, fontSize: 12.5 }}>{en}</div>
      </div>
    </div>
  );
}

function statusTone(status) {
  return status === "confirmed" ? "confirmed" : status === "pending" ? "pending" : status === "canceled" ? "canceled" : "empty";
}
function statusLabel(status) {
  return status === "confirmed" ? "확정 Confirmed"
    : status === "pending" ? "검토중 Pending"
    : status === "canceled" ? "취소 Canceled"
    : "반려 Rejected";
}

function Badge({ children, tone }) {
  const tones = {
    empty: { bg: "transparent", fg: MUTED, border: "#8a8378" },
    pending: { bg: "#3a2f14", fg: "#E8C27A", border: GOLD },
    confirmed: { bg: "#12312a", fg: "#7FD9BE", border: "#3fae8d" },
    canceled: { bg: "#3a1414", fg: "#E8A6A6", border: LACQUER },
  };
  const t = tones[tone] || tones.empty;
  return (
    <span
      style={{
        display: "inline-block", fontSize: 11, fontFamily: MONO, letterSpacing: "0.05em",
        padding: "2px 8px", borderRadius: 3, border: `1px solid ${t.border}`,
        color: t.fg, background: t.bg, whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function SectionLabel({ n, kr, en }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 14px" }}>
      <span style={{ ...styles.mono, fontSize: 12, color: LACQUER, border: `1px solid ${LACQUER}`, borderRadius: 20, padding: "2px 8px" }}>
        {n}
      </span>
      <span>
        <span style={{ fontSize: 17, fontWeight: 700, color: INK }}>{kr}</span>
        <span style={{ fontSize: 12.5, color: MUTED, marginLeft: 8 }}>{en}</span>
      </span>
    </div>
  );
}

function Field({ kr, en, required, hint, hintEn, children }) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span style={{ display: "block", fontSize: 13.5, fontWeight: 500, marginBottom: 6, color: INK }}>
        {kr} <span style={{ color: MUTED, fontWeight: 400, fontSize: 12 }}>{en}</span>
        {required && <span style={{ color: LACQUER, marginLeft: 3 }}>*</span>}
      </span>
      {children}
      {hint && (
        <span style={{ display: "block", fontSize: 11.5, color: MUTED, marginTop: 4, lineHeight: 1.6 }}>
          {hint}
          {hintEn && <><br />{hintEn}</>}
        </span>
      )}
    </label>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", border: `1px solid #AEB6C4`, borderRadius: 4,
  padding: "9px 11px", fontSize: 14, fontFamily: SANS, background: "#F1F4F9", color: INK, outline: "none",
};
function TextInput(props) { return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} />; }
function TextArea(props) { return <textarea {...props} style={{ ...inputStyle, resize: "vertical", ...(props.style || {}) }} />; }
function Select(props) { return <select {...props} style={{ ...inputStyle, ...(props.style || {}) }} />; }

function PillButton({ active, onClick, children, accent = LACQUER }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        cursor: "pointer", border: `1px solid ${active ? accent : "#AEB6C4"}`,
        background: active ? accent : "transparent", color: active ? "#FFF9EC" : INK,
        borderRadius: 20, padding: "7px 14px", fontSize: 13, fontWeight: 500, fontFamily: SANS, transition: "all .15s",
      }}
    >
      {children}
    </button>
  );
}

const emptyForm = {
  track: "",
  companyName: "", boothNo: "", picName: "", picPosition: "",
  phoneCountry: "kr", picPhone: "", picEmail: "",
  sessionTitle: "", sessionDescription: "", companyLogo: "",
  day: DAYS[0].key, startTime: STANDARD_START_TIMES[0], duration: 45,
};

export default function App() {
  useEffect(() => { loadFonts(); }, []);

  const [view, setView] = useState("schedule");
  const [apps, setApps] = useState(null);
  const [selectedBlock, setSelectedBlock] = useState(null);

  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [passError, setPassError] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [accessCode, setAccessCode] = useState(DEFAULT_ACCESS_CODE);

  const [blockForm, setBlockForm] = useState({ day: DAYS[0].key, startTime: "09:00", endTime: "15:00", label: "", org: "", track: "" });
  const [blockError, setBlockError] = useState("");

  const [blockedForm, setBlockedForm] = useState({ day: DAYS[0].key, startTime: "09:00", endTime: "09:45", label: "" });
  const [blockedError, setBlockedError] = useState("");

  async function refresh() {
    let list = [];
    try {
      const res = await window.storage.get("applications", true);
      list = res && res.value ? JSON.parse(res.value) : [];
    } catch (e) {
      list = [];
    }
    let seeded = false;
    try {
      const seedFlag = await window.storage.get("defaultBlocksSeeded", true);
      seeded = !!(seedFlag && seedFlag.value);
    } catch (e) {
      seeded = false;
    }
    if (!seeded) {
      const missing = DEFAULT_BLOCKS.filter(
        (db) => !list.some((a) => a.isBlocked && a.day === db.day && a.startTime === db.startTime)
      );
      if (missing.length) {
        list = [...list, ...missing.map((db) => makeBlockedRecord(db.day, db.startTime, db.duration))];
      }
      try {
        await window.storage.set("applications", JSON.stringify(list), true);
        await window.storage.set("defaultBlocksSeeded", JSON.stringify(true), true);
      } catch (e) {
        console.error("storage error", e);
      }
    }
    setApps(list);
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const unsubscribe = subscribeApplications(() => refresh());
    return unsubscribe;
  }, []);

  async function loadAccessCode() {
    try {
      const res = await window.storage.get("adminAccessCode", true);
      if (res && res.value) setAccessCode(JSON.parse(res.value));
    } catch (e) {
      // no custom code saved yet — keep default
    }
  }
  useEffect(() => { loadAccessCode(); }, []);

  async function changeAccessCode(current, next) {
    if (current !== accessCode) {
      return { ok: false, message: "현재 코드가 올바르지 않습니다. Current code is incorrect." };
    }
    if (!next || next.trim().length < 4) {
      return { ok: false, message: "새 코드는 4자 이상이어야 합니다. New code must be at least 4 characters." };
    }
    const trimmed = next.trim();
    setAccessCode(trimmed);
    try {
      await window.storage.set("adminAccessCode", JSON.stringify(trimmed), true);
    } catch (e) {
      console.error("storage error", e);
    }
    return { ok: true, message: "접속 코드가 변경되었습니다. Access code updated." };
  }

  async function deleteApp(id) {
    const next = (apps || []).filter((a) => a.id !== id);
    await persist(next);
  }

  async function updateAppTime(id, day, startTime) {
    const next = (apps || []).map((a) => (a.id === id ? { ...a, day, startTime } : a));
    await persist(next);
  }

  async function updateAppFields(id, fields) {
    const next = (apps || []).map((a) => (a.id === id ? { ...a, ...fields } : a));
    await persist(next);
  }

  async function persist(next) {
    setApps(next);
    try {
      await window.storage.set("applications", JSON.stringify(next), true);
    } catch (e) {
      console.error("storage error", e);
    }
  }

  function pickSlot(day, approxMin) {
    const startTime = nearestStandardStart(approxMin);
    setForm((f) => ({ ...f, day, startTime }));
    setView("apply");
  }

  async function addSpecialBlock() {
    setBlockError("");
    const { day, startTime, endTime, label, org, track } = blockForm;
    if (!track) { setBlockError("박람회 유형을 선택해주세요. Please select a fair type."); return; }
    const s = toMinutes(startTime);
    const e = toMinutes(endTime);
    if (e <= s) { setBlockError("종료 시간이 시작 시간보다 늦어야 합니다. End time must be after start time."); return; }
    if (!label.trim()) { setBlockError("일정 제목을 입력해주세요. Please enter a title."); return; }
    const conflict = findConflict(apps || [], day, s, e, null, 0);
    if (conflict) { setBlockError(`이미 등록된 일정과 겹칩니다 (${conflict.companyName || conflict.sessionTitle}). Overlaps an existing item.`); return; }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const record = {
      id, day, startTime, duration: e - s, track,
      sessionTitle: label, companyName: org || "주최측 프로그램 / Organizer program",
      sessionDescription: "", picName: "", picPosition: "", phoneCountry: "kr", picPhone: "", picEmail: "",
      boothNo: "", companyLogo: "",
      status: "confirmed", isSpecial: true, submittedAt: new Date().toISOString(),
    };
    await persist([...(apps || []), record]);
    setBlockForm({ day: DAYS[0].key, startTime: "09:00", endTime: "15:00", label: "", org: "", track: "" });
  }

  async function addBlockedTime() {
    setBlockedError("");
    const { day, startTime, endTime, label } = blockedForm;
    const s = toMinutes(startTime);
    const e = toMinutes(endTime);
    if (e <= s) { setBlockedError("종료 시간이 시작 시간보다 늦어야 합니다. End time must be after start time."); return; }
    const conflict = findConflict(apps || [], day, s, e, null, 0);
    if (conflict) { setBlockedError(`이미 등록된 일정과 겹칩니다 (${conflict.sessionTitle || conflict.companyName}). Overlaps an existing item.`); return; }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const record = {
      id, day, startTime, duration: e - s, track: "",
      sessionTitle: label.trim() || "이용 불가 Unavailable", companyName: "",
      sessionDescription: "", picName: "", picPosition: "", phoneCountry: "kr", picPhone: "", picEmail: "",
      boothNo: "", companyLogo: "",
      status: "confirmed", isSpecial: true, isBlocked: true, submittedAt: new Date().toISOString(),
    };
    await persist([...(apps || []), record]);
    setBlockedForm({ day: DAYS[0].key, startTime: "09:00", endTime: "09:45", label: "" });
  }

  const startMin = toMinutes(form.startTime);
  const endMin = startMin + SESSION_LEN;
  const overLimit = endMin > DAY_END;
  const conflict = apps ? findConflict(apps, form.day, startMin, endMin, editingId) : null;
  const slotOk = !overLimit && !conflict;

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submitForm(e) {
    e.preventDefault();
    setSubmitError("");
    if (!form.track) {
      setSubmitError("행사 구분을 선택해주세요. Please select a fair type.");
      return;
    }
    const required = [
      ["companyName", "업체/기관명 Company / Institution Name"], ["boothNo", "부스 번호 Booth No."],
      ["picName", "담당자 성명 PIC Name"], ["picPhone", "담당자 휴대폰 Cell phone"], ["picEmail", "담당자 이메일 Email"],
      ["sessionTitle", "세션명(영문) Session Title"], ["sessionDescription", "세션 소개(영문) Session Description"],
    ];
    for (const [k, label] of required) {
      if (!form[k] || !form[k].trim()) {
        setSubmitError(`'${label}' 항목을 입력해주세요. Please fill in '${label}'.`);
        return;
      }
    }
    if (!form.picEmail.includes("@")) {
      setSubmitError("올바른 이메일 형식이 아닙니다 (@ 포함 필요). Please enter a valid email address (must include '@').");
      return;
    }
    if (overLimit) { setSubmitError("선택하신 시간대가 운영 시간(17:45)을 초과합니다. The slot exceeds closing time (17:45)."); return; }
    if (conflict) { setSubmitError("선택하신 시간대는 앞뒤 세션과 겹치거나 15분 간격이 부족합니다. This time overlaps another session or lacks the required 15-minute gap."); return; }
    setSubmitting(true);
    let record;
    let next;
    if (editingId) {
      record = { ...form, id: editingId, duration: SESSION_LEN, status: "pending", submittedAt: new Date().toISOString() };
      next = (apps || []).map((a) => (a.id === editingId ? record : a));
    } else {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      record = { id, ...form, duration: SESSION_LEN, status: "pending", submittedAt: new Date().toISOString() };
      next = [...(apps || []), record];
    }
    await persist(next);
    setSubmitting(false);
    setConfirmation(record);
    sendNewApplicationAlert(record);
    setEditingId(null);
    setForm(emptyForm);
  }

  function startEdit(record) {
    setEditingId(record.id);
    setForm({
      track: record.track || "",
      companyName: record.companyName || "", boothNo: record.boothNo || "",
      picName: record.picName || "", picPosition: record.picPosition || "",
      phoneCountry: record.phoneCountry || "kr", picPhone: record.picPhone || "", picEmail: record.picEmail || "",
      sessionTitle: record.sessionTitle || "", sessionDescription: record.sessionDescription || "",
      companyLogo: record.companyLogo || "",
      day: record.day || DAYS[0].key, startTime: record.startTime || STANDARD_START_TIMES[0],
    });
    setConfirmation(null);
    setView("apply");
  }

  function setAppStatus(id, status) {
    const next = (apps || []).map((a) => (a.id === id ? { ...a, status } : a));
    persist(next);
    if (status === "confirmed" || status === "rejected" || status === "canceled") {
      const target = next.find((a) => a.id === id);
      if (target && !target.isSpecial) sendStatusEmail(target, status);
    }
  }

  const filteredAdminApps = useMemo(() => {
    if (!apps) return [];
    const sorted = [...apps].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
    if (statusFilter === "all") return sorted;
    if (statusFilter === "unavailable") return sorted.filter((a) => a.isBlocked);
    return sorted.filter((a) => a.status === statusFilter);
  }, [apps, statusFilter]);

  return (
    <div style={styles.page}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 20px 64px" }}>
        <Header view={view} setView={setView} />

        {view === "schedule" && (
          <ScheduleView
            apps={apps} loading={apps === null}
            selectedBlock={selectedBlock} setSelectedBlock={setSelectedBlock}
            pickSlot={pickSlot} goApply={() => setView("apply")}
          />
        )}

        {view === "apply" && (
          <ApplyView
            form={form} update={update} submitForm={submitForm} submitting={submitting}
            submitError={submitError} confirmation={confirmation} setConfirmation={setConfirmation}
            slotOk={slotOk} overLimit={overLimit} conflict={conflict} startMin={startMin} endMin={endMin}
            editingId={editingId} startEdit={startEdit} apps={apps}
          />
        )}

        {view === "lookup" && <LookupView apps={apps} startEdit={startEdit} />}

        {view === "admin" && !adminUnlocked && (
          <AdminGate
            passInput={passInput} setPassInput={setPassInput} passError={passError}
            onSubmit={() => {
              if (passInput === accessCode) { setAdminUnlocked(true); setPassError(false); }
              else setPassError(true);
            }}
          />
        )}

        {view === "admin" && adminUnlocked && (
          <AdminView
            apps={filteredAdminApps} allApps={apps || []} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
            setAppStatus={setAppStatus} blockForm={blockForm} setBlockForm={setBlockForm}
            blockError={blockError} addSpecialBlock={addSpecialBlock}
            blockedForm={blockedForm} setBlockedForm={setBlockedForm}
            blockedError={blockedError} addBlockedTime={addBlockedTime}
            deleteApp={deleteApp} changeAccessCode={changeAccessCode} updateAppTime={updateAppTime} updateAppFields={updateAppFields}
          />
        )}

        <Footer view={view} setView={setView} />
      </div>
    </div>
  );
}

function Header({ view, setView }) {
  const tabs = [
    { key: "schedule", kr: "스테이지 스케줄", en: "Stage Schedule" },
    { key: "apply", kr: "세션 신청하기", en: "Apply for a Session" },
    { key: "lookup", kr: "내 신청 조회", en: "My Application" },
  ];
  return (
    <header style={{ padding: "40px 0 24px", borderBottom: `2px solid ${INK}` }}>
      <div style={{ ...styles.mono, fontSize: 12, letterSpacing: "0.14em", color: GOLD_DARK, marginBottom: 8 }}>
        HANOI · OCT 15–18, 2026
      </div>
      <h1 style={{ fontSize: "clamp(26px, 5vw, 38px)", fontWeight: 700, margin: "0 0 6px", color: INK, letterSpacing: "-0.01em" }}>
        VIETBABY <span style={{ color: LACQUER }}>&</span> VIETEDU 2026
      </h1>
      <p style={{ margin: "0 0 24px", fontSize: 14.5, color: MUTED }}>
        스테이지 세션 스케줄 확인 및 세미나 신청<br />
        Check the stage schedule and apply for a seminar session
      </p>
      <nav style={{ display: "flex", gap: 8 }}>
        {tabs.map((t) => (
          <button
            key={t.key} onClick={() => setView(t.key)}
            style={{
              cursor: "pointer", border: "none",
              borderBottom: view === t.key ? `2px solid ${LACQUER}` : "2px solid transparent",
              background: "transparent", padding: "10px 4px", marginRight: 24,
              fontFamily: SANS, textAlign: "left",
            }}
          >
            <span style={{ display: "block", fontSize: 15, fontWeight: 500, color: view === t.key ? INK : MUTED }}>{t.kr}</span>
            <span style={{ display: "block", fontSize: 11, color: MUTED }}>{t.en}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}

function Footer({ view, setView }) {
  return (
    <footer style={{ marginTop: 56, paddingTop: 20, borderTop: `1px solid ${BORDER}`, textAlign: "center" }}>
      {view !== "admin" && (
        <button
          onClick={() => setView("admin")}
          style={{ cursor: "pointer", background: "none", border: "none", fontSize: 12.5, color: MUTED, fontFamily: SANS, lineHeight: 1.6 }}
        >
          주최자이신가요? 신청 내역 관리 →<br />
          <span style={{ fontSize: 11 }}>Organizer? Manage applications →</span>
        </button>
      )}
    </footer>
  );
}

function MiniSchedule({ apps, selectedDay }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>실시간 스테이지 스케줄</span>
        <span style={{ fontSize: 11.5, color: MUTED }}>Live Stage Schedule</span>
      </div>
      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ minWidth: 640 }}>
          <div style={{ display: "flex" }}>
            <div style={{ width: 58, flexShrink: 0 }} />
            <div style={{ flex: 1, position: "relative", height: 16 }}>
              {HOUR_TICKS.filter((t) => !SKIP_LABEL.has(t)).map((t) => (
                <span
                  key={t}
                  style={{
                    position: "absolute", left: `${pct(t)}%`,
                    transform: t === DAY_END ? "translateX(-100%)" : "translateX(-50%)",
                    fontSize: 9.5, color: MUTED, ...styles.mono,
                  }}
                >
                  {tickLabel(t)}
                </span>
              ))}
            </div>
          </div>
          {DAYS.map((d) => {
            const blocks = computeDayBlocks(apps || [], d.key);
            const isSel = d.key === selectedDay;
            return (
              <div key={d.key} style={{ display: "flex", alignItems: "stretch", marginBottom: 5 }}>
                <div style={{ width: 58, flexShrink: 0, display: "flex", alignItems: "center", paddingRight: 6 }}>
                  <span style={{ ...styles.mono, fontSize: 11, color: isSel ? LACQUER : INK, fontWeight: isSel ? 700 : 400 }}>{d.short}</span>
                </div>
                <div style={{ flex: 1, position: "relative", height: 26, background: "#E9EDF4", border: `1px solid ${isSel ? LACQUER : BORDER}`, borderRadius: 3 }}>
                  {blocks.map((b, i) => {
                    if (b.status === "empty") return null;
                    const left = pct(b.startMin);
                    const width = pct(b.endMin) - left;
                    let fill;
                    if (b.app.isBlocked) {
                      fill = "repeating-linear-gradient(45deg, #C7CEDA, #C7CEDA 3px, #AEB6C6 3px, #AEB6C6 6px)";
                    } else {
                      const t = TRACKS[b.app.track] || TRACKS.vietbaby;
                      fill = b.status === "pending" ? t.light : t.strong;
                    }
                    return (
                      <div
                        key={i}
                        title={b.app.isBlocked ? "이용 불가 Unavailable" : `${b.app.sessionTitle} · ${b.app.companyName}`}
                        style={{ position: "absolute", left: `${left}%`, width: `${width}%`, top: 2, bottom: 2, background: fill, borderRadius: 2 }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ScheduleView({ apps, loading, selectedBlock, setSelectedBlock, pickSlot, goApply }) {
  if (loading) {
    return (
      <section style={{ paddingTop: 60, textAlign: "center", color: INK, ...styles.mono, fontSize: 13 }}>
        <Loader2 size={16} style={{ verticalAlign: "-3px", marginRight: 8 }} />
        불러오는 중… Loading…
      </section>
    );
  }

  const legendRows = [
    { key: "vietbaby", kr: "베이비페어", en: "VIETBABY", light: LACQUER_LIGHT, dark: LACQUER },
    { key: "vietedu", kr: "교육박람회", en: "VIETEDU", light: BLUE_LIGHT, dark: BLUE },
  ];

  return (
    <section style={{ paddingTop: 28 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: INK, margin: "0 0 3px" }}>스테이지 스케줄 실시간 현황 조회</h2>
      <p style={{ fontSize: 12.5, color: MUTED, margin: "0 0 14px" }}>Live Stage Schedule Status</p>
      <p style={{ fontSize: 13.5, color: INK, margin: "0 0 4px" }}>
        4일간 전체 일정을 한 화면에서 볼 수 있어요. 막대를 클릭하면 세부 정보가, 빈 구간을 클릭하면 신청서가 열립니다.
      </p>
      <p style={{ fontSize: 12, color: INK, margin: "0 0 16px" }}>
        See all four days on one screen. Click a bar for details, or click an empty slot to open the application form.
      </p>

      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ minWidth: 700 }}>
          <div style={{ display: "flex" }}>
            <div style={{ width: 76, flexShrink: 0 }} />
            <div style={{ flex: 1, position: "relative", height: 22 }}>
              {HOUR_TICKS.filter((t) => !SKIP_LABEL.has(t)).map((t) => (
                <span
                  key={t}
                  style={{
                    position: "absolute", left: `${pct(t)}%`,
                    transform: t === DAY_END ? "translateX(-100%)" : "translateX(-50%)",
                    fontSize: 11, color: INK, ...styles.mono,
                  }}
                >
                  {tickLabel(t)}
                </span>
              ))}
            </div>
          </div>

          {DAYS.map((d) => {
            const blocks = computeDayBlocks(apps || [], d.key);
            return (
              <div key={d.key} style={{ display: "flex", alignItems: "stretch", marginBottom: 8 }}>
                <div style={{ width: 76, flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 8 }}>
                  <div style={{ ...styles.mono, fontSize: 13, color: INK }}>{d.short}</div>
                  <div style={{ fontSize: 10, color: INK, letterSpacing: "0.05em" }}>{d.dow}</div>
                </div>
                <div style={{ flex: 1, position: "relative", height: 56, background: "#E9EDF4", border: `1px solid ${BORDER}`, borderRadius: 4 }}>
                  {HOUR_TICKS.map((t) => (
                    <div key={t} style={{ position: "absolute", left: `${pct(t)}%`, top: 0, bottom: 0, width: 1, background: "rgba(20,20,20,0.10)" }} />
                  ))}
                  {blocks.map((b, i) => {
                    const left = pct(b.startMin);
                    const width = pct(b.endMin) - left;
                    const isSel = selectedBlock && selectedBlock.day === d.key && selectedBlock.startMin === b.startMin;
                    const isBlocked = b.status !== "empty" && b.app.isBlocked;

                    let fill = "transparent", fg = "#8a8378", fgSub = "#8a8378";
                    if (isBlocked) {
                      fill = "repeating-linear-gradient(45deg, #C7CEDA, #C7CEDA 5px, #AEB6C6 5px, #AEB6C6 10px)";
                      fg = "#2B2E35";
                    } else if (b.status !== "empty") {
                      const t = TRACKS[b.app.track] || TRACKS.vietbaby;
                      if (b.status === "pending") { fill = t.light; fg = t.text; fgSub = t.text + "CC"; }
                      else { fill = t.strong; fg = "#FFFFFF"; fgSub = "rgba(255,255,255,0.82)"; }
                    }
                    const showLabel = width > 6;
                    const showTwoLines = width > 16;

                    return (
                      <div
                        key={i}
                        onClick={(e) => {
                          if (b.status !== "empty") {
                            setSelectedBlock({ day: d.key, startMin: b.startMin, app: b.app, status: b.status });
                            return;
                          }
                          const rect = e.currentTarget.getBoundingClientRect();
                          const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
                          const clickedMin = b.startMin + fraction * (b.endMin - b.startMin);
                          pickSlot(d.key, clickedMin);
                        }}
                        title={
                          b.status === "empty"
                            ? "빈 시간 · 신청하기 / Open · click to apply"
                            : isBlocked
                            ? "이용 불가 / Unavailable"
                            : `${b.app.sessionTitle} · ${b.app.companyName}`
                        }
                        style={{
                          position: "absolute", left: `${left}%`, width: `${width}%`, top: 4, bottom: 4,
                          background: fill,
                          boxShadow: b.status !== "empty" && !isBlocked ? "inset 0 0 0 1px rgba(0,0,0,0.12)" : "none",
                          border: isSel ? `2px solid ${INK}` : b.status === "empty" ? "1px dashed #AEB6C4" : isBlocked ? "1px solid #9AA1AF" : "none",
                          borderRadius: 3, cursor: "pointer", overflow: "hidden",
                          display: "flex", flexDirection: "column", alignItems: showLabel && !isBlocked ? "stretch" : "center", justifyContent: "center",
                          padding: showLabel && !isBlocked ? "0 8px" : 0,
                        }}
                      >
                        {b.status !== "empty" && (
                          isBlocked ? (
                            <span style={{ fontSize: 13, fontWeight: 700, color: fg }}>✕</span>
                          ) : (
                            showLabel && (
                              <>
                                <span style={{ fontSize: 11.5, color: fg, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  <span style={{ ...styles.mono, fontWeight: 600 }}>{toHHMM(b.startMin)}–{toHHMM(b.endMin)}</span> {b.app.sessionTitle}
                                </span>
                                {showTwoLines && (
                                  <span style={{ fontSize: 11, color: fgSub, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {b.app.companyName}
                                  </span>
                                )}
                              </>
                            )
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
        {legendRows.map((row, i) => (
          <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: INK, minWidth: 150 }}>
              {row.kr} <span style={{ fontWeight: 400 }}>{row.en}</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 14, height: 14, borderRadius: 2, background: row.light, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: INK }}>확정전 <span style={{ fontWeight: 400 }}>Before confirmed</span></span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 14, height: 14, borderRadius: 2, background: row.dark, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: INK }}>확정 <span style={{ fontWeight: 400 }}>Confirmed</span></span>
            </span>
            {i === 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 14, height: 14, borderRadius: 2, border: "1.5px dashed #8a8378", flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: INK }}>OPEN <span style={{ fontWeight: 400 }}>신청 가능 Open</span></span>
              </span>
            )}
            {i === 1 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 14, height: 14, borderRadius: 2, background: "repeating-linear-gradient(45deg, #C7CEDA, #C7CEDA 3px, #AEB6C6 3px, #AEB6C6 6px)", border: "1px solid #9AA1AF", flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: INK }}>✕ 이용 불가 <span style={{ fontWeight: 400 }}>Unavailable</span></span>
              </span>
            )}
          </div>
        ))}
      </div>

      {selectedBlock && (
        <div style={{ position: "relative", marginTop: 18, padding: "16px 44px 16px 18px", border: `1px solid ${BORDER}`, borderRadius: 6, background: "#F1F4F9" }}>
          <button
            onClick={() => setSelectedBlock(null)}
            aria-label="닫기 Close"
            style={{
              position: "absolute", top: 10, right: 10, cursor: "pointer",
              width: 26, height: 26, borderRadius: "50%", border: `1px solid ${BORDER}`,
              background: "#FFFFFF", color: MUTED, display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
            }}
          >
            <X size={14} />
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>
                {selectedBlock.app.isBlocked ? "이용 불가 Unavailable" : selectedBlock.app.sessionTitle}
              </div>
              <div style={{ fontSize: 12.5, color: INK, marginTop: 3 }}>
                {DAYS.find((d) => d.key === selectedBlock.day).kr} · {selectedBlock.app.startTime}–
                {toHHMM(toMinutes(selectedBlock.app.startTime) + selectedBlock.app.duration)}
                {!selectedBlock.app.isBlocked && ` · ${selectedBlock.app.companyName}`}
              </div>
              {!selectedBlock.app.isBlocked && selectedBlock.app.track && (
                <div style={{ fontSize: 12, color: TRACKS[selectedBlock.app.track].text, marginTop: 3, fontWeight: 500 }}>
                  {TRACKS[selectedBlock.app.track].kr} · {TRACKS[selectedBlock.app.track].en}
                </div>
              )}
            </div>
            {!selectedBlock.app.isBlocked && (
              <Badge tone={selectedBlock.status}>
                {selectedBlock.status === "pending" ? "검토중 Pending" : "확정 Confirmed"}
              </Badge>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, padding: "18px 20px", border: `1px solid ${NOTICE_BORDER}`, borderRadius: 6, background: PAPER_2 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <span style={{ fontSize: 14, color: INK }}>
            원하는 시간대가 비어있나요? 지금 세션을 신청해보세요.<br />
            <span style={{ fontSize: 12 }}>Found an open slot you like? Apply for a session now.</span>
          </span>
          <button
            onClick={goApply}
            style={{ cursor: "pointer", border: "none", background: LACQUER, color: "#FFF9EC", padding: "10px 18px", borderRadius: 4, fontSize: 13.5, fontWeight: 500, fontFamily: SANS }}
          >
            세션 신청하기 Apply
          </button>
        </div>
        <div style={{ borderTop: `1px solid ${NOTICE_BORDER}`, marginTop: 16, paddingTop: 14 }}>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              ["본 세미나 참가 비용은 무료입니다.", "Participation in this seminar is free of charge."],
              ["세션 신청은 사전 신청 기업에 한해 가능하며, 현장 신청은 불가합니다.", "Sessions are open only to companies that applied in advance — on-site registration is not available."],
              ["발표자료는 반드시 USB에 저장하여 지참해주시기 바랍니다.", "Please bring your presentation materials saved on a USB drive."],
            ].map(([kr, en], i) => (
              <li key={i} style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                <span style={{ color: NOTICE_ICON, flexShrink: 0 }}>·</span>
                <span>
                  <span style={{ color: INK }}>{kr}</span><br />
                  <span style={{ color: MUTED }}>{en}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function LookupView({ apps, startEdit }) {
  const [boothInput, setBoothInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  function handleLookup(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    const booth = boothInput.trim().toLowerCase();
    const email = emailInput.trim().toLowerCase();
    if (!booth || !email) {
      setError("부스 번호와 이메일을 모두 입력해주세요. Please enter both the booth number and email.");
      return;
    }
    const found = (apps || []).find(
      (a) => !a.isSpecial && (a.boothNo || "").trim().toLowerCase() === booth && (a.picEmail || "").toLowerCase() === email
    );
    if (!found) {
      setError("일치하는 신청 내역을 찾을 수 없습니다. 부스 번호와 이메일을 확인해주세요. No matching application found — please check your booth number and email.");
      return;
    }
    setResult(found);
  }

  return (
    <section style={{ paddingTop: 28, maxWidth: 480 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: INK, margin: "0 0 3px" }}>내 신청 조회</h2>
      <p style={{ fontSize: 12.5, color: MUTED, margin: "0 0 20px" }}>My Application</p>

      <form onSubmit={handleLookup}>
        <Field kr="부스 번호" en="Booth Number" required>
          <TextInput value={boothInput} onChange={(e) => setBoothInput(e.target.value)} placeholder="A-102" />
        </Field>
        <Field
          kr="담당자 이메일" en="Email" required
          hint="세션 접수 때 기재해주신 메일을 기재해주셔야 조회가 가능합니다."
          hintEn="Enter the same email you used when submitting the session — otherwise the lookup won't find it."
        >
          <TextInput value={emailInput} onChange={(e) => setEmailInput(e.target.value)} placeholder="name@company.com" />
        </Field>
        {error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: LACQUER_DARK, fontSize: 13, marginBottom: 16 }}>
            <AlertCircle size={15} /> {error}
          </div>
        )}
        <button
          type="submit"
          style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: "none", background: LACQUER, color: "#FFF9EC", padding: "10px 20px", borderRadius: 4, fontSize: 14, fontWeight: 500, fontFamily: SANS }}
        >
          <Search size={15} /> 조회하기 Look up
        </button>
      </form>

      {result && (
        <div style={{ marginTop: 24, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "18px 20px", background: "#FAFAFC" }}>
          <Row kr="행사 구분" en="Fair type" value={TRACKS[result.track] ? `${TRACKS[result.track].kr} / ${TRACKS[result.track].en}` : "-"} />
          <Row kr="업체명" en="Company" value={result.companyName} />
          <Row kr="부스 번호" en="Booth" value={result.boothNo} />
          <Row kr="세션명" en="Session" value={result.sessionTitle} />
          <Row
            kr="일시" en="Time"
            value={`${DAYS.find((d) => d.key === result.day)?.kr} ${result.startTime}–${toHHMM(toMinutes(result.startTime) + result.duration)}`}
          />
          <Row
            kr="상태" en="Status"
            value={statusLabel(result.status)}
          />
          <button
            onClick={() => startEdit(result)}
            style={{ marginTop: 16, cursor: "pointer", border: `1px solid ${INK}`, background: "transparent", padding: "9px 16px", borderRadius: 4, fontSize: 13.5, fontFamily: SANS }}
          >
            수정하기 Edit this application
          </button>
        </div>
      )}
    </section>
  );
}

function ApplyView({ form, update, submitForm, submitting, submitError, confirmation, setConfirmation, slotOk, overLimit, conflict, startMin, endMin, editingId, startEdit, apps }) {
  const [logoError, setLogoError] = useState("");
  const accent = form.track === "vietedu" ? BLUE : LACQUER;
  const accentDark = form.track === "vietedu" ? BLUE_DARK : LACQUER_DARK;

  function setPhoneCountry(country) {
    const digits = form.picPhone.replace(/\D/g, "");
    update("phoneCountry", country);
    update("picPhone", formatPhoneDigits(country, digits));
  }
  function handlePhoneChange(e) {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 11);
    update("picPhone", formatPhoneDigits(form.phoneCountry, digits));
  }
  function handleLogoChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setLogoError("이미지 파일만 업로드 가능합니다. Please upload an image file."); return; }
    if (file.size > 1.5 * 1024 * 1024) { setLogoError("파일 크기는 1.5MB 이하만 가능합니다. File must be 1.5MB or smaller."); return; }
    setLogoError("");
    const reader = new FileReader();
    reader.onload = () => update("companyLogo", reader.result);
    reader.readAsDataURL(file);
  }

  if (confirmation) {
    return (
      <section style={{ paddingTop: 40, maxWidth: 520 }}>
        <CheckCircle2 size={30} color={LACQUER} />
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: "14px 0 2px" }}>신청이 접수되었습니다</h2>
        <p style={{ fontSize: 13, color: MUTED, margin: "0 0 16px" }}>Your application has been received.</p>
        <p style={{ fontSize: 14, color: MUTED, marginBottom: 4 }}>담당자 확인 후 최종 시간대가 확정되며, 결과는 기재하신 이메일로 안내드립니다.</p>
        <p style={{ fontSize: 12.5, color: MUTED, marginBottom: 20 }}>The organizer will review and confirm the final time; you'll be notified by email.</p>
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "18px 20px", background: "#F1F4F9" }}>
          <Row kr="행사 구분" en="Fair type" value={TRACKS[confirmation.track] ? `${TRACKS[confirmation.track].kr} / ${TRACKS[confirmation.track].en}` : "-"} />
          <Row kr="업체명" en="Company" value={confirmation.companyName} />
          <Row kr="부스 번호" en="Booth" value={confirmation.boothNo} />
          <Row kr="세션명" en="Session" value={confirmation.sessionTitle} />
          <Row
            kr="희망 일시" en="Requested time"
            value={`${DAYS.find((d) => d.key === confirmation.day).kr} ${confirmation.startTime}–${toHHMM(toMinutes(confirmation.startTime) + confirmation.duration)}`}
          />
          <Row kr="상태" en="Status" value="검토중 Pending review" />
        </div>

        <div style={{ marginTop: 20, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "14px 18px", background: PAPER_2 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 10 }}>문의처 Contacts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {CONTACTS.map((c, i) => <ContactCard key={i} c={c} />)}
          </div>
        </div>

        <button
          onClick={() => setConfirmation(null)}
          style={{ marginTop: 20, marginRight: 10, cursor: "pointer", border: `1px solid ${INK}`, background: "transparent", padding: "9px 16px", borderRadius: 4, fontSize: 13.5, fontFamily: SANS }}
        >
          새 신청서 작성하기 Start a new application
        </button>
        <button
          onClick={() => startEdit(confirmation)}
          style={{ marginTop: 20, cursor: "pointer", border: "none", background: LACQUER, color: "#FFF9EC", padding: "9px 16px", borderRadius: 4, fontSize: 13.5, fontFamily: SANS }}
        >
          수정하기 Edit this application
        </button>
      </section>
    );
  }

  return (
    <section style={{ paddingTop: 28 }}>
      <div style={{ border: `1px solid ${NOTICE_BORDER}`, borderRadius: 6, padding: "18px 20px", background: PAPER_2, fontSize: 13, color: INK, marginBottom: 28 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <Info size={16} style={{ flexShrink: 0, color: NOTICE_ICON }} />
          <strong style={{ fontSize: 13.5, color: LACQUER }}>신청 마감: 2026년 9월 14일 · Deadline: Sep 14, 2026</strong>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <NoticeItem n="1" kr="발표자료는 USB에 저장하여 지참해주세요." en="Bring your slides on a USB drive." />
          <NoticeItem
            n="2"
            kr={<>모든 세션은 <strong style={{ color: LACQUER }}>45분</strong>이며, 앞뒤 세션과 <strong style={{ color: LACQUER }}>15분 간격</strong>이 자동으로 확보됩니다.</>}
            en={<>Every session is a fixed <strong style={{ color: LACQUER }}>45 minutes</strong>, and a <strong style={{ color: LACQUER }}>15-minute gap</strong> from neighboring sessions is enforced automatically.</>}
          />
          <NoticeItem n="3" kr="모든 정보는 영문 또는 베트남어로 작성해주세요." en="Please fill in all information in English or Vietnamese." />
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ ...styles.mono, fontSize: 11, color: NOTICE_ICON, border: `1px solid ${NOTICE_ICON}`, borderRadius: "50%", width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
              4
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ color: INK, fontWeight: 600, marginBottom: 8 }}>문의 Contact</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {CONTACTS.map((c, i) => <ContactCard key={i} c={c} />)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={submitForm}>
        {editingId && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, border: `1px solid ${NOTICE_BORDER}`, background: PAPER_2, borderRadius: 6, padding: "10px 14px", marginBottom: 20, fontSize: 13, color: INK }}>
            <Info size={15} style={{ color: NOTICE_ICON, flexShrink: 0, marginTop: 1 }} />
            <div>
              기존 신청서를 수정하는 중입니다. 제출하면 검토중 상태로 다시 바뀝니다.<br />
              <span style={{ color: MUTED }}>Editing an existing application — resubmitting will set it back to pending review.</span>
            </div>
          </div>
        )}

        <SectionLabel n="00" kr="행사 구분" en="Fair Type" />
        <div style={{ display: "flex", gap: 10, marginBottom: 28 }}>
          {Object.values(TRACKS).map((t) => (
            <PillButton key={t.key} active={form.track === t.key} onClick={() => update("track", t.key)} accent={t.strong}>
              {t.kr} <span style={{ opacity: 0.85 }}>· {t.en}</span>
            </PillButton>
          ))}
        </div>

        <SectionLabel n="01" kr="기본 정보" en="Basic Information" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field kr="업체/기관명" en="Company / Institution" required>
            <TextInput value={form.companyName} onChange={(e) => update("companyName", e.target.value)} placeholder="ABC Company" />
          </Field>
          <Field kr="부스 번호" en="Booth No." required>
            <TextInput value={form.boothNo} onChange={(e) => update("boothNo", e.target.value)} placeholder="A-102" />
          </Field>
          <Field kr="담당자 성명" en="PIC Name" required>
            <TextInput value={form.picName} onChange={(e) => update("picName", e.target.value)} />
          </Field>
          <Field kr="담당자 직책" en="PIC Position">
            <TextInput value={form.picPosition} onChange={(e) => update("picPosition", e.target.value)} />
          </Field>
          <Field kr="담당자 휴대폰" en="Cell Phone" required hint="숫자만 입력하면 자동으로 하이픈이 추가됩니다." hintEn="Digits only — hyphens are added automatically.">
            <div style={{ display: "flex", gap: 8 }}>
              <Select value={form.phoneCountry} onChange={(e) => setPhoneCountry(e.target.value)} style={{ width: 130, flexShrink: 0 }}>
                {Object.keys(COUNTRY_CODES).map((k) => (
                  <option key={k} value={k}>{COUNTRY_CODES[k].kr} {COUNTRY_CODES[k].code}</option>
                ))}
              </Select>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ ...styles.mono, fontSize: 13, color: INK, flexShrink: 0 }}>{COUNTRY_CODES[form.phoneCountry].code}</span>
                <TextInput
                  value={form.picPhone} onChange={handlePhoneChange} inputMode="numeric"
                  placeholder={form.phoneCountry === "kr" ? "10-1234-5678" : "91-234-5678"}
                />
              </div>
            </div>
          </Field>
          <Field kr="담당자 이메일" en="Email" required>
            <TextInput type="email" value={form.picEmail} onChange={(e) => update("picEmail", e.target.value)} placeholder="name@company.com" />
          </Field>
        </div>

        <div style={{ height: 1, background: "#D5DAE3", margin: "8px 0 28px" }} />

        <SectionLabel n="02" kr="세미나 정보" en="Session Information" />
        <Field kr="세션명 (영문)" en="Session Title (English)" required hint="외부 홍보에 그대로 사용됩니다." hintEn="Used as-is for external promotion.">
          <TextInput value={form.sessionTitle} onChange={(e) => update("sessionTitle", e.target.value)} placeholder="Session Title (English)" />
        </Field>
        <Field kr="세션 소개 (영문)" en="Session Description (English)" required hint="참관객 대상 소개문으로, 영문으로 작성해주세요." hintEn="Visitor-facing description, in English.">
          <TextArea rows={4} value={form.sessionDescription} onChange={(e) => update("sessionDescription", e.target.value)} placeholder="Session description in English" />
        </Field>

        <MiniSchedule apps={apps} selectedDay={form.day} />

        <Field kr="희망 날짜" en="Requested Date" required>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {DAYS.map((d) => (
              <PillButton key={d.key} active={form.day === d.key} onClick={() => update("day", d.key)} accent={accent}>
                {d.kr} <span style={{ opacity: 0.85 }}>· {d.en}</span>
              </PillButton>
            ))}
          </div>
        </Field>

        <Field kr="시작 시간" en="Start Time" required hint="모든 세션은 45분 고정입니다." hintEn="All sessions are a fixed 45 minutes.">
          <Select value={form.startTime} onChange={(e) => update("startTime", e.target.value)} style={{ maxWidth: 180 }}>
            {STANDARD_START_TIMES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>

        <div
          style={{
            display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, padding: "10px 14px", borderRadius: 4, marginBottom: 24,
            background: slotOk ? "#EAF3EE" : "#FBEAEA", color: slotOk ? "#1F4E44" : LACQUER_DARK,
            border: `1px solid ${slotOk ? "#BFDDCF" : "#EFC3C3"}`,
          }}
        >
          {slotOk ? <CheckCircle2 size={15} style={{ marginTop: 1, flexShrink: 0 }} /> : <AlertCircle size={15} style={{ marginTop: 1, flexShrink: 0 }} />}
          <span>
            {overLimit ? (
              <>
                운영 시간(17:45)을 초과합니다.<br />
                <span style={{ opacity: 0.85 }}>Exceeds closing time (17:45).</span>
              </>
            ) : conflict ? (
              <>
                다른 세션과 겹치거나 15분 간격이 부족합니다 ({conflict.companyName}, {conflict.startTime} 시작).<br />
                <span style={{ opacity: 0.85 }}>Overlaps {conflict.companyName} at {conflict.startTime} or violates the 15-min gap.</span>
              </>
            ) : (
              <>
                {toHHMM(startMin)}–{toHHMM(endMin)} · 신청 가능<br />
                <span style={{ opacity: 0.85 }}>Available</span>
              </>
            )}
          </span>
        </div>

        <Field kr="기업 로고" en="Company Logo" hint="PNG/JPG, 1.5MB 이하 권장." hintEn="PNG/JPG recommended, up to 1.5MB.">
          <input type="file" accept="image/*" onChange={handleLogoChange} style={{ fontSize: 13, fontFamily: SANS }} />
          {logoError && <div style={{ color: LACQUER_DARK, fontSize: 11.5, marginTop: 4 }}>{logoError}</div>}
          {form.companyLogo && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
              <img src={form.companyLogo} alt="logo preview" style={{ height: 48, borderRadius: 4, border: `1px solid ${BORDER}` }} />
              <button type="button" onClick={() => update("companyLogo", "")} style={{ cursor: "pointer", border: `1px solid ${MUTED}`, background: "transparent", color: MUTED, padding: "4px 10px", borderRadius: 4, fontSize: 12, fontFamily: SANS }}>
                제거 Remove
              </button>
            </div>
          )}
        </Field>

        {submitError && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: LACQUER_DARK, fontSize: 13, margin: "20px 0 0" }}>
            <AlertCircle size={15} /> {submitError}
          </div>
        )}

        <button
          type="submit" disabled={submitting}
          style={{ marginTop: 20, cursor: submitting ? "default" : "pointer", border: "none", background: accent, color: "#FFF9EC", padding: "12px 22px", borderRadius: 4, fontSize: 14.5, fontWeight: 500, fontFamily: SANS, opacity: submitting ? 0.7 : 1 }}
        >
          {submitting ? "제출 중… Submitting…" : editingId ? "수정 완료 Update Application" : "신청서 제출 Submit Application"}
        </button>

        <div style={{ marginTop: 24, display: "flex", gap: 10, alignItems: "flex-start", border: `1px solid ${NOTICE_BORDER}`, borderRadius: 6, padding: "14px 16px", background: PAPER_2 }}>
          <AlertCircle size={16} style={{ marginTop: 1, flexShrink: 0, color: NOTICE_ICON }} />
          <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.8 }}>
            주최사에서도 홍보를 진행하나, 참가사 자체 홍보를 병행해주셔야 효과적인 관람객 유입이 가능합니다.<br />
            <span style={{ color: MUTED }}>The organizer will also promote the event, but participating companies should carry out their own promotion as well for effective visitor turnout.</span>
          </div>
        </div>
      </form>
    </section>
  );
}

function Row({ kr, en, value, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #EFE7D2", fontSize: 13.5, gap: 12 }}>
      <span style={{ color: MUTED, flexShrink: 0 }}>{kr} <span style={{ fontSize: 11 }}>{en}</span></span>
      <span style={{ fontWeight: 500, fontFamily: mono ? MONO : "inherit", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function AdminGate({ passInput, setPassInput, passError, onSubmit }) {
  return (
    <section style={{ paddingTop: 56, maxWidth: 360 }}>
      <Lock size={22} color={MUTED} />
      <h2 style={{ fontSize: 19, fontWeight: 700, margin: "12px 0 2px" }}>주최자 로그인</h2>
      <p style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>Organizer login</p>
      <p style={{ fontSize: 13, color: MUTED, marginBottom: 4 }}>신청 내역을 확인하고 세션을 확정하려면 접속 코드를 입력하세요.</p>
      <p style={{ fontSize: 12, color: MUTED, marginBottom: 16 }}>Enter the access code to review applications and confirm sessions.</p>
      <TextInput type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)} placeholder="접속 코드 Access code" onKeyDown={(e) => e.key === "Enter" && onSubmit()} />
      {passError && <div style={{ color: LACQUER_DARK, fontSize: 12.5, marginTop: 6 }}>코드가 올바르지 않습니다. Incorrect code.</div>}
      <button onClick={onSubmit} style={{ marginTop: 12, cursor: "pointer", border: "none", background: INK, color: PAPER, padding: "10px 18px", borderRadius: 4, fontSize: 13.5, fontFamily: SANS }}>
        입장 Enter
      </button>
    </section>
  );
}

function AdminView({
  apps, allApps, statusFilter, setStatusFilter, setAppStatus, blockForm, setBlockForm, blockError, addSpecialBlock,
  blockedForm, setBlockedForm, blockedError, addBlockedTime, deleteApp, changeAccessCode, updateAppTime, updateAppFields,
}) {
  const [adminTab, setAdminTab] = useState("applications");
  const [confirmedOnly, setConfirmedOnly] = useState(true);
  const [editingTimeId, setEditingTimeId] = useState(null);
  const [editDay, setEditDay] = useState("");
  const [editStart, setEditStart] = useState("");
  const [logoDownloadMsg, setLogoDownloadMsg] = useState("");
  const [boothQuery, setBoothQuery] = useState("");
  const [editingContentId, setEditingContentId] = useState(null);
  const [contentDraft, setContentDraft] = useState({});
  const filters = [
    { key: "all", kr: "전체", en: "All" },
    { key: "pending", kr: "검토중", en: "Pending" },
    { key: "confirmed", kr: "확정", en: "Confirmed" },
    { key: "rejected", kr: "반려", en: "Rejected" },
    { key: "canceled", kr: "취소", en: "Canceled" },
    { key: "unavailable", kr: "이용불가", en: "Unavailable" },
  ];
  const tabs = [
    { key: "applications", kr: "신청 내역 관리", en: "Applications" },
    { key: "boothSearch", kr: "신청 조회", en: "Search" },
    { key: "longForm", kr: "장시간 일정 등록", en: "Long-form Schedule" },
    { key: "blockSlot", kr: "스테이지 시간 추가", en: "Add Stage Time" },
    { key: "settings", kr: "설정", en: "Settings" },
  ];

  const realApps = (allApps || []).filter((a) => !a.isBlocked && !a.isSpecial);
  const stats = {
    total: realApps.length,
    pending: realApps.filter((a) => a.status === "pending").length,
    confirmed: realApps.filter((a) => a.status === "confirmed").length,
    rejected: realApps.filter((a) => a.status === "rejected").length,
  };
  const now = new Date();
  const daysUntilDeadline = Math.ceil((APPLICATION_DEADLINE - now) / 86400000);
  const stalePending = realApps.filter(
    (a) => a.status === "pending" && (now - new Date(a.submittedAt)) / 86400000 >= STALE_PENDING_DAYS
  );
  const boothMatches = boothQuery.trim()
    ? realApps.filter((a) => (a.boothNo || "").toLowerCase().includes(boothQuery.trim().toLowerCase()))
    : [];

  function beginTimeEdit(a) {
    setEditingTimeId(a.id);
    setEditDay(a.day);
    setEditStart(a.startTime);
  }
  function cancelTimeEdit() {
    setEditingTimeId(null);
  }
  function saveTimeEdit(a) {
    updateAppTime(a.id, editDay, editStart);
    setEditingTimeId(null);
  }

  function beginContentEdit(a) {
    setEditingContentId(a.id);
    setContentDraft({
      sessionTitle: a.sessionTitle || "",
      companyName: a.companyName || "",
      boothNo: a.boothNo || "",
      picName: a.picName || "",
      picPosition: a.picPosition || "",
      picEmail: a.picEmail || "",
      picPhone: a.picPhone || "",
      sessionDescription: a.sessionDescription || "",
      track: a.track || "",
    });
  }
  function cancelContentEdit() {
    setEditingContentId(null);
  }
  function saveContentEdit(a) {
    updateAppFields(a.id, contentDraft);
    setEditingContentId(null);
  }

  return (
    <section style={{ paddingTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <ShieldCheck size={18} color={LACQUER} />
        <h2 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>관리자 페이지</h2>
      </div>
      <p style={{ fontSize: 12, color: MUTED, margin: "0 0 18px" }}>Admin</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 24, borderBottom: `1px solid ${BORDER}`, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.key} onClick={() => setAdminTab(t.key)}
            style={{
              cursor: "pointer", border: "none",
              borderBottom: adminTab === t.key ? `2px solid ${LACQUER}` : "2px solid transparent",
              background: "transparent", padding: "8px 4px", marginRight: 20, fontFamily: SANS, textAlign: "left",
            }}
          >
            <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: adminTab === t.key ? INK : MUTED }}>{t.kr}</span>
            <span style={{ display: "block", fontSize: 11, color: MUTED }}>{t.en}</span>
          </button>
        ))}
      </div>

      {adminTab === "blockSlot" && (
        <div style={{ border: `1px dashed ${GOLD_DARK}`, borderRadius: 6, padding: "16px 18px", background: PAPER_2 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 2px" }}>스테이지 시간 추가</h3>
          <p style={{ fontSize: 11.5, color: MUTED, margin: "0 0 12px" }}>Add a stage time slot</p>
          <p style={{ fontSize: 12.5, color: MUTED, margin: "0 0 14px" }}>
            표준 신청 흐름 밖에서 스케줄에 직접 넣고 싶은 시간대를 추가하세요. 라벨을 비워두면 "이용 불가(✕)"로 표시되어 참가사가 그 시간을 신청할 수 없습니다.<br />
            Add any time block directly to the schedule outside the normal application flow. Leave the label blank to mark it "Unavailable (✕)" — applicants won't be able to select that time.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 12 }}>
            <label>
              <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>Date</span>
              <Select value={blockedForm.day} onChange={(e) => setBlockedForm((f) => ({ ...f, day: e.target.value }))}>
                {DAYS.map((d) => <option key={d.key} value={d.key}>{d.en}</option>)}
              </Select>
            </label>
            <label>
              <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>시작 Start</span>
              <TextInput
                type="time" value={blockedForm.startTime}
                onChange={(e) => setBlockedForm((f) => ({ ...f, startTime: e.target.value }))}
                step="60"
              />
            </label>
            <label>
              <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>종료 End</span>
              <TextInput
                type="time" value={blockedForm.endTime}
                onChange={(e) => setBlockedForm((f) => ({ ...f, endTime: e.target.value }))}
                step="60"
              />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <TextInput
              placeholder="라벨 (선택, 비워두면 '이용 불가') Label (optional — leave blank for 'Unavailable')"
              value={blockedForm.label} onChange={(e) => setBlockedForm((f) => ({ ...f, label: e.target.value }))}
            />
          </div>
          {blockedError && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", color: LACQUER_DARK, fontSize: 12.5, marginBottom: 10 }}>
              <AlertCircle size={13} /> {blockedError}
            </div>
          )}
          <button onClick={addBlockedTime} style={{ cursor: "pointer", border: "none", background: GOLD_DARK, color: "#FFF9EC", padding: "9px 16px", borderRadius: 4, fontSize: 13, fontFamily: SANS }}>
            시간 추가 Add
          </button>
        </div>
      )}

      {adminTab === "boothSearch" && (
        <div style={{ maxWidth: 560 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 2 }}>부스 번호로 검색</div>
          <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 14 }}>Search by booth number</div>
          <TextInput
            value={boothQuery} onChange={(e) => setBoothQuery(e.target.value)}
            placeholder="예: A-102 Booth number" style={{ maxWidth: 240, marginBottom: 18 }}
          />
          {boothQuery.trim() === "" ? (
            <p style={{ fontSize: 13, color: MUTED }}>부스 번호를 입력해주세요. Enter a booth number to search.</p>
          ) : boothMatches.length === 0 ? (
            <p style={{ fontSize: 13, color: MUTED }}>일치하는 부스가 없습니다. No matching booth found.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {boothMatches.map((a) => (
                <div key={a.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "12px 14px", background: "#FAFAFC" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                        {a.companyName} <span style={{ fontWeight: 400, color: MUTED, fontSize: 12 }}>· 부스 Booth {a.boothNo}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>{a.sessionTitle}</div>
                    </div>
                    <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
                  </div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: INK, marginTop: 8 }}>
                    <span><Calendar size={12} style={{ verticalAlign: "-2px" }} /> {DAYS.find((d) => d.key === a.day)?.kr} {a.startTime}</span>
                    <span><User size={12} style={{ verticalAlign: "-2px" }} /> {a.picName}</span>
                    <span><Mail size={12} style={{ verticalAlign: "-2px" }} /> {a.picEmail}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {adminTab === "longForm" && (
        <div style={{ border: `1px dashed ${GOLD_DARK}`, borderRadius: 6, padding: "16px 18px", background: PAPER_2 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 2px" }}>장시간·특별 일정 등록</h3>
          <p style={{ fontSize: 11.5, color: MUTED, margin: "0 0 12px" }}>Register a long-form / special program</p>
          <p style={{ fontSize: 12.5, color: MUTED, margin: "0 0 14px" }}>
            9:00–15:00처럼 45분을 넘는 행사·축제·부스 프로그램은 여기서 직접 등록하세요. (15분 간격 규칙은 적용되지 않고, 겹치는 일정만 막습니다.)<br />
            For programs longer than 45 minutes (e.g. 9:00–15:00), register them here directly. The 15-minute gap rule does not apply — only overlaps are blocked.
          </p>

          <div style={{ marginBottom: 12 }}>
            <span style={{ display: "block", fontSize: 12, marginBottom: 6, color: MUTED }}>박람회 유형 Fair type</span>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.values(TRACKS).map((t) => (
                <PillButton key={t.key} active={blockForm.track === t.key} onClick={() => setBlockForm((f) => ({ ...f, track: t.key }))} accent={t.strong}>
                  {t.kr} <span style={{ opacity: 0.85 }}>· {t.en}</span>
                </PillButton>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 12 }}>
            <label>
              <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>Date</span>
              <Select value={blockForm.day} onChange={(e) => setBlockForm((f) => ({ ...f, day: e.target.value }))}>
                {DAYS.map((d) => <option key={d.key} value={d.key}>{d.en}</option>)}
              </Select>
            </label>
            <label>
              <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>시작 Start</span>
              <Select value={blockForm.startTime} onChange={(e) => setBlockForm((f) => ({ ...f, startTime: e.target.value }))}>
                {FINE_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </label>
            <label>
              <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>종료 End</span>
              <Select value={blockForm.endTime} onChange={(e) => setBlockForm((f) => ({ ...f, endTime: e.target.value }))}>
                {FINE_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <TextInput placeholder="일정 제목 Title (예: Steam Festival)" value={blockForm.label} onChange={(e) => setBlockForm((f) => ({ ...f, label: e.target.value }))} />
            <TextInput placeholder="주관 Organizer (예: 주최측 / 부서명)" value={blockForm.org} onChange={(e) => setBlockForm((f) => ({ ...f, org: e.target.value }))} />
          </div>
          {blockError && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", color: LACQUER_DARK, fontSize: 12.5, marginBottom: 10 }}>
              <AlertCircle size={13} /> {blockError}
            </div>
          )}
          <button onClick={addSpecialBlock} style={{ cursor: "pointer", border: "none", background: GOLD_DARK, color: "#FFF9EC", padding: "9px 16px", borderRadius: 4, fontSize: 13, fontFamily: SANS }}>
            일정 등록 Register
          </button>
        </div>
      )}

      {adminTab === "applications" && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
            {[
              ["전체", "Total", stats.total, INK],
              ["검토중", "Pending", stats.pending, "#8C6A25"],
              ["확정", "Confirmed", stats.confirmed, "#1F4E44"],
              ["반려", "Rejected", stats.rejected, LACQUER],
            ].map(([kr, en, val, color]) => (
              <div key={kr} style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "10px 18px", minWidth: 96, background: "#FAFAFC" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
                <div style={{ fontSize: 11, color: MUTED }}>{kr} <span>{en}</span></div>
              </div>
            ))}
          </div>

          {(daysUntilDeadline <= 14 || stalePending.length > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {daysUntilDeadline < 0 ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", border: `1px solid #EFC3C3`, background: "#FBEAEA", borderRadius: 6, padding: "10px 14px", fontSize: 13, color: LACQUER_DARK }}>
                  <AlertCircle size={15} /> 신청 마감일(2026년 9월 14일)이 지났습니다. <span style={{ opacity: 0.85 }}>The application deadline (Sep 14, 2026) has passed.</span>
                </div>
              ) : daysUntilDeadline <= 14 ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", border: `1px solid ${NOTICE_BORDER}`, background: PAPER_2, borderRadius: 6, padding: "10px 14px", fontSize: 13, color: INK }}>
                  <Info size={15} style={{ color: NOTICE_ICON, flexShrink: 0 }} /> 신청 마감까지 D-{daysUntilDeadline}일 남았습니다. <span style={{ color: MUTED }}>{daysUntilDeadline} days left until the deadline.</span>
                </div>
              ) : null}
              {stalePending.length > 0 && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", border: `1px solid #EFC3C3`, background: "#FBEAEA", borderRadius: 6, padding: "10px 14px", fontSize: 13, color: LACQUER_DARK }}>
                  <AlertCircle size={15} /> {STALE_PENDING_DAYS}일 이상 검토중인 신청이 {stalePending.length}건 있습니다.
                  <span style={{ opacity: 0.85 }}> {stalePending.length} application{stalePending.length > 1 ? "s" : ""} pending review for {STALE_PENDING_DAYS}+ days.</span>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "14px 16px", marginBottom: 12, background: "#F1F4F9" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>스케줄 다운로드 <span style={{ fontWeight: 400, color: MUTED }}>Export schedule</span></div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: MUTED, marginTop: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} />
                확정만 포함 Confirmed only
              </label>
            </div>
            <button
              onClick={() => exportScheduleXlsx(allApps, confirmedOnly)}
              style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: "none", background: "#1F4E44", color: "#FFF9EC", padding: "9px 16px", borderRadius: 4, fontSize: 13, fontFamily: SANS }}
            >
              <Download size={14} /> 엑셀 다운로드 Download Excel (.xls)
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "14px 16px", marginBottom: 18, background: "#F1F4F9" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>기업 로고 일괄 다운로드 <span style={{ fontWeight: 400, color: MUTED }}>Bulk download logos</span></div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                로고가 첨부된 신청서를 전부 압축(.zip) 파일 하나로 묶어서 다운로드합니다.<br />
                Downloads every uploaded logo bundled into a single .zip file.
              </div>
            </div>
            <button
              onClick={async () => {
                setLogoDownloadMsg("압축 중… Zipping…");
                const count = await downloadAllLogosZip(allApps);
                setLogoDownloadMsg(count === 0 ? "다운로드할 로고가 없습니다. No logos to download." : `${count}개 로고를 zip으로 다운로드했습니다. Downloaded ${count} logos as a zip.`);
              }}
              style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6, border: "none", background: GOLD_DARK, color: "#FFF9EC", padding: "9px 16px", borderRadius: 4, fontSize: 13, fontFamily: SANS, flexShrink: 0 }}
            >
              <Download size={14} /> 로고 전체 다운로드 (.zip) Download all
            </button>
          </div>
          {logoDownloadMsg && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: -8, marginBottom: 18 }}>{logoDownloadMsg}</div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            {filters.map((f) => (
              <PillButton key={f.key} active={statusFilter === f.key} onClick={() => setStatusFilter(f.key)} accent={INK}>
                {f.kr} <span style={{ opacity: 0.85 }}>{f.en}</span>
              </PillButton>
            ))}
          </div>

          {apps.length === 0 ? (
            <p style={{ fontSize: 13.5, color: MUTED }}>해당하는 신청 내역이 없습니다. No matching applications.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {apps.map((a) => (
                <div key={a.id} style={{ border: `1px solid ${BORDER}`, borderRadius: 6, padding: "14px 16px", background: "#F1F4F9" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {a.companyLogo && (
                        <img
                          src={a.companyLogo} alt="company logo"
                          style={{ width: 44, height: 44, objectFit: "contain", borderRadius: 4, border: `1px solid ${BORDER}`, background: "#fff", flexShrink: 0 }}
                        />
                      )}
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>{a.sessionTitle}</div>
                        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                          {a.companyName} {a.boothNo && `· 부스 ${a.boothNo}`}
                        </div>
                        {a.track && (
                          <div style={{ fontSize: 11.5, color: TRACKS[a.track].text, marginTop: 3, fontWeight: 500 }}>
                            {TRACKS[a.track].kr} · {TRACKS[a.track].en}
                          </div>
                        )}
                        {a.isBlocked && (
                          <div style={{ fontSize: 11.5, color: "#3F434C", marginTop: 3, fontWeight: 500 }}>
                            ✕ 이용 불가 Unavailable
                          </div>
                        )}
                        {a.companyLogo && (
                          <button
                            onClick={() => downloadDataUrl(a.companyLogo, `${(a.companyName || "logo").replace(/[^\w.-]+/g, "_")}.${logoExtension(a.companyLogo)}`)}
                            style={{ cursor: "pointer", border: "none", background: "none", color: LACQUER, fontSize: 11.5, padding: 0, marginTop: 4, textDecoration: "underline" }}
                          >
                            로고 다운로드 Download logo
                          </button>
                        )}
                      </div>
                    </div>
                    <Badge tone={statusTone(a.status)}>{statusLabel(a.status)}</Badge>
                  </div>

                  {editingTimeId === a.id ? (
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", margin: "10px 0", padding: "10px 12px", background: PAPER_2, borderRadius: 4 }}>
                      <label>
                        <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>Date</span>
                        <Select value={editDay} onChange={(e) => setEditDay(e.target.value)} style={{ width: 150 }}>
                          {DAYS.map((d) => <option key={d.key} value={d.key}>{d.en}</option>)}
                        </Select>
                      </label>
                      <label>
                        <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>시작 Start</span>
                        <Select value={editStart} onChange={(e) => setEditStart(e.target.value)} style={{ width: 120 }}>
                          {(a.isSpecial ? FINE_SLOTS : STANDARD_START_TIMES).map((s) => <option key={s} value={s}>{s}</option>)}
                        </Select>
                      </label>
                      <button onClick={() => saveTimeEdit(a)} style={miniBtn("#1F4E44")}>
                        <CheckCircle2 size={13} /> 저장 Save
                      </button>
                      <button onClick={cancelTimeEdit} style={miniBtn(MUTED)}>
                        <X size={13} /> 취소 Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, color: INK, margin: "10px 0" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <Calendar size={13} /> {DAYS.find((d) => d.key === a.day)?.kr} <span style={{ color: MUTED }}>{DAYS.find((d) => d.key === a.day)?.en}</span> {a.startTime} ({a.duration}분 <span style={{ color: MUTED }}>min</span>)
                      </span>
                      {!a.isSpecial && (
                        <>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><User size={13} /> {a.picName} {a.picPosition && `(${a.picPosition})`}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Phone size={13} /> {COUNTRY_CODES[a.phoneCountry]?.code} {a.picPhone}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Mail size={13} /> {a.picEmail}</span>
                        </>
                      )}
                    </div>
                  )}

                  {editingContentId === a.id && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "10px 0", padding: "14px", background: PAPER_2, borderRadius: 4 }}>
                      {!a.isSpecial && (
                        <div>
                          <span style={{ display: "block", fontSize: 11, marginBottom: 6, color: MUTED }}>박람회 유형 Fair type</span>
                          <div style={{ display: "flex", gap: 8 }}>
                            {Object.values(TRACKS).map((t) => (
                              <PillButton
                                key={t.key} active={contentDraft.track === t.key}
                                onClick={() => setContentDraft((d) => ({ ...d, track: t.key }))} accent={t.strong}
                              >
                                {t.kr}
                              </PillButton>
                            ))}
                          </div>
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <label>
                          <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>세션명 Session Title</span>
                          <TextInput value={contentDraft.sessionTitle} onChange={(e) => setContentDraft((d) => ({ ...d, sessionTitle: e.target.value }))} />
                        </label>
                        <label>
                          <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>업체명 Company</span>
                          <TextInput value={contentDraft.companyName} onChange={(e) => setContentDraft((d) => ({ ...d, companyName: e.target.value }))} />
                        </label>
                        {!a.isSpecial && (
                          <>
                            <label>
                              <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>부스 번호 Booth</span>
                              <TextInput value={contentDraft.boothNo} onChange={(e) => setContentDraft((d) => ({ ...d, boothNo: e.target.value }))} />
                            </label>
                            <label>
                              <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>담당자 성명 PIC Name</span>
                              <TextInput value={contentDraft.picName} onChange={(e) => setContentDraft((d) => ({ ...d, picName: e.target.value }))} />
                            </label>
                            <label>
                              <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>담당자 직책 PIC Position</span>
                              <TextInput value={contentDraft.picPosition} onChange={(e) => setContentDraft((d) => ({ ...d, picPosition: e.target.value }))} />
                            </label>
                            <label>
                              <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>이메일 Email</span>
                              <TextInput value={contentDraft.picEmail} onChange={(e) => setContentDraft((d) => ({ ...d, picEmail: e.target.value }))} />
                            </label>
                            <label>
                              <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>휴대폰 Phone</span>
                              <TextInput value={contentDraft.picPhone} onChange={(e) => setContentDraft((d) => ({ ...d, picPhone: e.target.value }))} />
                            </label>
                          </>
                        )}
                      </div>
                      {!a.isSpecial && (
                        <label>
                          <span style={{ display: "block", fontSize: 11, marginBottom: 3, color: MUTED }}>세션 소개 Session Description</span>
                          <TextArea rows={3} value={contentDraft.sessionDescription} onChange={(e) => setContentDraft((d) => ({ ...d, sessionDescription: e.target.value }))} />
                        </label>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => saveContentEdit(a)} style={miniBtn("#1F4E44")}>
                          <CheckCircle2 size={13} /> 저장 Save
                        </button>
                        <button onClick={cancelContentEdit} style={miniBtn(MUTED)}>
                          <X size={13} /> 취소 Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {editingTimeId !== a.id && (
                      <button onClick={() => beginTimeEdit(a)} style={miniBtn(GOLD_DARK)}>
                        <Calendar size={13} /> 시간 수정 Edit time
                      </button>
                    )}
                    {editingContentId !== a.id && (
                      <button onClick={() => beginContentEdit(a)} style={miniBtn(NOTICE_ICON)}>
                        <User size={13} /> 내용 수정 Edit details
                      </button>
                    )}
                    {a.isBlocked ? (
                      <button onClick={() => deleteApp(a.id)} style={miniBtn(LACQUER)}>
                        <X size={13} /> 삭제 Delete
                      </button>
                    ) : (
                      <>
                        {a.status !== "confirmed" && (
                          <button onClick={() => setAppStatus(a.id, "confirmed")} style={miniBtn("#1F4E44")}>
                            <CheckCircle2 size={13} /> 확정 Confirm
                          </button>
                        )}
                        {a.status !== "rejected" && (
                          <button onClick={() => setAppStatus(a.id, "rejected")} style={miniBtn(LACQUER)}>
                            <X size={13} /> 반려 Reject
                          </button>
                        )}
                        {a.status !== "canceled" && (
                          <button onClick={() => setAppStatus(a.id, "canceled")} style={miniBtn(LACQUER_DARK)}>
                            <X size={13} /> 취소 Cancel
                          </button>
                        )}
                        {a.status !== "pending" && (
                          <button onClick={() => setAppStatus(a.id, "pending")} style={miniBtn(MUTED)}>
                            <RotateCcw size={13} /> 검토중으로 Set pending
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {adminTab === "settings" && <AccessCodeForm changeAccessCode={changeAccessCode} />}
    </section>
  );
}

function AccessCodeForm({ changeAccessCode }) {
  const [curCode, setCurCode] = useState("");
  const [newCode, setNewCode] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [msg, setMsg] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg(null);
    if (newCode !== confirmCode) {
      setMsg({ ok: false, text: "새 코드가 일치하지 않습니다. New codes do not match." });
      return;
    }
    const result = await changeAccessCode(curCode, newCode);
    setMsg({ ok: result.ok, text: result.message });
    if (result.ok) {
      setCurCode(""); setNewCode(""); setConfirmCode("");
    }
  }

  return (
    <div style={{ border: `1px dashed ${GOLD_DARK}`, borderRadius: 6, padding: "16px 18px", background: PAPER_2, maxWidth: 420 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 2px" }}>접속 코드 변경</h3>
      <p style={{ fontSize: 11.5, color: MUTED, margin: "0 0 14px" }}>Change admin access code</p>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>현재 코드 Current code</span>
          <TextInput type="password" value={curCode} onChange={(e) => setCurCode(e.target.value)} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>새 코드 New code</span>
          <TextInput type="password" value={newCode} onChange={(e) => setNewCode(e.target.value)} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <span style={{ display: "block", fontSize: 12, marginBottom: 4, color: MUTED }}>새 코드 확인 Confirm new code</span>
          <TextInput type="password" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} />
        </div>
        {msg && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, marginBottom: 12, color: msg.ok ? "#1F4E44" : LACQUER_DARK }}>
            {msg.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />} {msg.text}
          </div>
        )}
        <button type="submit" style={{ cursor: "pointer", border: "none", background: GOLD_DARK, color: "#FFF9EC", padding: "9px 16px", borderRadius: 4, fontSize: 13, fontFamily: SANS }}>
          변경 Change
        </button>
      </form>
    </div>
  );
}

function miniBtn(color) {
  return {
    cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
    border: `1px solid ${color}`, background: "transparent", color,
    padding: "5px 10px", borderRadius: 4, fontSize: 12, fontFamily: SANS,
  };
}
