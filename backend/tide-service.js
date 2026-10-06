const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");
const { pool } = require("./db");
require("dotenv").config();

const SOURCE_BASE = process.env.TIDE_SOURCE_BASE_URL || "https://www.phongchonglutbaotphcm.gov.vn";
const ARCHIVE_MONTH_LOOKBACK = Number(process.env.TIDE_ARCHIVE_MONTH_LOOKBACK || 12);
const FETCH_INTERVAL_MINUTES = Number(process.env.TIDE_FETCH_INTERVAL_MINUTES || 60);
const STALE_HOURS = Number(process.env.TIDE_STALE_HOURS || 48);
const AUTO_FETCH = String(process.env.TIDE_AUTO_FETCH ?? "true").toLowerCase() !== "false";
const SAVE_PDF = String(process.env.TIDE_SAVE_PDF ?? "true").toLowerCase() !== "false";
const PDF_ARCHIVE_DIR = path.resolve(__dirname, process.env.TIDE_PDF_ARCHIVE_DIR || "tide_data");
const SAVE_PARSE_DEBUG = String(process.env.TIDE_SAVE_PARSE_DEBUG ?? "true").toLowerCase() !== "false";

const HTTP = axios.create({
    timeout: Number(process.env.TIDE_HTTP_TIMEOUT_MS || 20000),
    maxRedirects: 5,
    headers: {
        "User-Agent": "FloodMonitoringResearch/1.4 (+student IoT dashboard; automated public bulletin reader)",
        "Accept": "text/html,application/pdf;q=0.9,*/*;q=0.8"
    }
});

const TRACKED_STATIONS = [
    { key: "PHU_AN", names: ["phu an", "phú an"] },
    { key: "NHA_BE", names: ["nha be", "nhà bè"] },
    { key: "THU_DAU_MOT", names: ["thu dau mot", "thủ dầu một"] }
];

let scheduler = null;
let refreshPromise = null;
let lastRefreshResult = null;


function archiveFileName(discovered) {
    try {
        const pathname = new URL(discovered.url).pathname;
        const base = decodeURIComponent(path.basename(pathname));
        if (/\.pdf$/i.test(base)) {
            return base.replace(/[^A-Za-z0-9._-]/g, "_");
        }
    } catch (_) {}

    const stamp = String(discovered.date || formatDateLocal(new Date())).replace(/-/g, "");
    return `HCMC_TVHN_${stamp}.pdf`;
}

function archivePathFor(discovered) {
    return path.join(PDF_ARCHIVE_DIR, archiveFileName(discovered));
}

async function saveParseDebug(text, discovered) {
    if (!SAVE_PARSE_DEBUG) return null;
    try {
        await fs.promises.mkdir(PDF_ARCHIVE_DIR, { recursive: true });
        const base = archiveFileName(discovered).replace(/\.pdf$/i, "");
        const target = path.join(PDF_ARCHIVE_DIR, `${base}_parsed.txt`);
        await fs.promises.writeFile(target, String(text || ""), "utf8");
        return path.relative(__dirname, target).split(path.sep).join("/");
    } catch (_) {
        return null;
    }
}

async function savePdfArchive(buffer, discovered) {
    if (!SAVE_PDF || !buffer) return null;

    await fs.promises.mkdir(PDF_ARCHIVE_DIR, { recursive: true });
    const target = archivePathFor(discovered);
    await fs.promises.writeFile(target, buffer);

    const relative = path.relative(__dirname, target).split(path.sep).join("/");
    console.log(`[TIDE] PDF saved: ${relative}`);
    return relative;
}

async function ensurePdfArchive(discovered) {
    if (!SAVE_PDF) return null;

    const target = archivePathFor(discovered);
    if (fs.existsSync(target)) {
        return path.relative(__dirname, target).split(path.sep).join("/");
    }

    let buffer = discovered.prefetchedBuffer;
    if (!buffer) {
        const response = await HTTP.get(discovered.url, {
            responseType: "arraybuffer",
            maxContentLength: 12 * 1024 * 1024
        });
        buffer = Buffer.from(response.data);
    }

    return savePdfArchive(buffer, discovered);
}



// Render PDF theo tọa độ để giữ cấu trúc từng dòng của bảng.
// pdf-parse mặc định có thể dồn các ô bảng theo thứ tự không ổn định,
// đặc biệt với bản tin HCMC_TVHN_2026, làm mất các dòng ngày 04/09...
async function renderPageLayout(pageData) {
    const textContent = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false
    });

    const rows = [];
    const Y_TOLERANCE = 2.5;

    for (const item of textContent.items || []) {
        const str = String(item.str || "").trim();
        if (!str) continue;

        const transform = item.transform || [];
        const x = Number(transform[4] || 0);
        const y = Number(transform[5] || 0);

        let row = rows.find(r => Math.abs(r.y - y) <= Y_TOLERANCE);
        if (!row) {
            row = { y, items: [] };
            rows.push(row);
        }

        row.items.push({ x, str });
    }

    rows.sort((a, b) => b.y - a.y);

    return rows.map(row => {
        row.items.sort((a, b) => a.x - b.x);
        return row.items.map(item => item.str).join(" ").replace(/\s+/g, " ").trim();
    }).filter(Boolean).join("\n");
}


async function renderPageTokenDump(pageData) {
    const textContent = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
    return (textContent.items || []).map(item => {
        const str = String(item.str || "").trim();
        if (!str) return "";
        const transform = item.transform || [];
        const x = Number(transform[4] || 0);
        const y = Number(transform[5] || 0);
        return `@@T|${x.toFixed(2)}|${y.toFixed(2)}|${encodeURIComponent(str)}@@`;
    }).join("");
}

function parseTokenDumpItems(tokenDump) {
    const items = [];
    const regex = /@@T\|(-?\d+(?:\.\d+)?)\|(-?\d+(?:\.\d+)?)\|([^@]*?)@@/g;
    let match;
    while ((match = regex.exec(String(tokenDump || ""))) !== null) {
        let str = "";
        try { str = decodeURIComponent(match[3]); } catch (_) { str = match[3]; }
        str = String(str || "").trim();
        if (str) items.push({ x: Number(match[1]), y: Number(match[2]), str });
    }
    return items;
}

function aggregateHcmcRowsFromDayRows(dayRows) {
    const byDate = new Map();
    for (const item of dayRows) {
        if (!byDate.has(item.forecastDate)) byDate.set(item.forecastDate, []);
        byDate.get(item.forecastDate).push(item);
    }
    const rows = [];
    for (const [forecastDate, items] of [...byDate.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
        const slots = { H1: [], H2: [], L1: [], L2: [] };
        for (const item of items) {
            const [h1,t1,h2,t2,l1,lt1,l2,lt2] = item.tokens;
            for (const [slot, level, time] of [
                ["H1", parseLevel(h1), parseTime(t1)], ["H2", parseLevel(h2), parseTime(t2)],
                ["L1", parseLevel(l1), parseTime(lt1)], ["L2", parseLevel(l2), parseTime(lt2)]
            ]) if (level != null && time != null) slots[slot].push({ level, time });
        }
        const pickHigh = list => list.reduce((best,x)=>!best||x.level>best.level?x:best,null);
        const pickLow = list => list.reduce((best,x)=>!best||x.level<best.level?x:best,null);
        for (const e of [
            {eventType:"HIGH",eventIndex:1,value:pickHigh(slots.H1)},
            {eventType:"HIGH",eventIndex:2,value:pickHigh(slots.H2)},
            {eventType:"LOW",eventIndex:1,value:pickLow(slots.L1)},
            {eventType:"LOW",eventIndex:2,value:pickLow(slots.L2)}
        ]) if (e.value) rows.push({ station:"TP_HCM", forecastDate, eventType:e.eventType, eventIndex:e.eventIndex, levelM:e.value.level, eventTime:e.value.time });
    }
    return rows;
}

function parseForecastRowsFromTokenDump(tokenDump, bulletinDate) {
    const items = parseTokenDumpItems(tokenDump);
    if (!items.length) throw new Error("Token parser không đọc được text item có tọa độ từ PDF.");
    const expectedDates = Array.from({length:5},(_,i)=>addDaysToIsoDate(bulletinDate,i));
    const expectedSet = new Set(expectedDates);
    const sorted = [...items].sort((a,b)=>(b.y-a.y)||(a.x-b.x));
    const grouped = [];
    const Y_TOLERANCE = 4.5;
    for (const item of sorted) {
        let row = grouped.find(r=>Math.abs(r.y-item.y)<=Y_TOLERANCE);
        if (!row) { row={y:item.y,items:[]}; grouped.push(row); }
        row.items.push(item);
    }
    grouped.sort((a,b)=>b.y-a.y);
    const dayRows=[];
    for (const row of grouped) {
        row.items.sort((a,b)=>a.x-b.x);
        const line=row.items.map(i=>i.str).join(" ").replace(/\s+/g," ").trim();
        const dm=line.match(/(?:^|\s)(\d{1,2})\s*[\/. -]\s*(\d{1,2})(?=\s|$)/);
        if (!dm) continue;
        const day=Number(dm[1]), month=Number(dm[2]);
        const dayMonth=`${String(day).padStart(2,"0")}/${String(month).padStart(2,"0")}`;
        const forecastDate=resolveForecastDate(dayMonth,bulletinDate);
        if (!forecastDate || !expectedSet.has(forecastDate)) continue;
        const digitOffset=dm[0].search(/\d/);
        const start=(dm.index||0)+(digitOffset<0?0:digitOffset);
        const dateText=dm[0].slice(digitOffset<0?0:digitOffset);
        const tokens=line.slice(start+dateText.length).match(/(?:ct|\*|-?\d+(?:[.,]\d+)?)/gi)||[];
        if (tokens.length>=8) dayRows.push({dayMonth,forecastDate,tokens:tokens.slice(0,8),y:row.y});
    }
    const byDate=new Map(expectedDates.map(d=>[d,[]]));
    for (const row of dayRows) { const list=byDate.get(row.forecastDate); if (list && list.length<3) list.push(row); }
    const coverage=expectedDates.filter(d=>(byDate.get(d)?.length||0)>0);
    if (coverage.length<5) throw new Error(`Coordinate parser chỉ phủ ${coverage.length}/5 ngày (${coverage.join(", ")||"không có"}).`);
    const rebuilt=[]; for (const d of expectedDates) rebuilt.push(...(byDate.get(d)||[]));
    const rows=aggregateHcmcRowsFromDayRows(rebuilt);
    console.log(`[TIDE] Coordinate table parser: ${rebuilt.length} dòng ngày, ${rows.length} mốc triều, đủ 5/5 ngày.`);
    return rows;
}

function findForecastDateMatches(text) {
    const regex = /(?:^|\s)(\d{1,2})\s*[\/.-]\s*(\d{1,2})(?=\s|$)/g;
    const matches = [];
    let match;

    while ((match = regex.exec(String(text || ""))) !== null) {
        const day = Number(match[1]);
        const month = Number(match[2]);
        if (day < 1 || day > 31 || month < 1 || month > 12) continue;

        // index trỏ đúng vào chữ số ngày, bỏ qua whitespace bắt bởi (?:^|\s)
        const leading = match[0].search(/\d/);
        matches.push({
            index: match.index + (leading < 0 ? 0 : leading),
            fullLength: match[0].length - (leading < 0 ? 0 : leading),
            dayMonth: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`
        });
    }

    return matches;
}

function extractForecastDayRowsFromText(sourceText, bulletinDate) {
    const text = String(sourceText || "");
    const matches = findForecastDateMatches(text);
    const dayRows = [];

    for (let i = 0; i < matches.length; i++) {
        const current = matches[i];
        const start = current.index;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;

        const fragment = text.slice(start, end)
            .replace(/\|/g, " ")
            .replace(/MỰC NƯỚC DỰ BÁO\s*\(m\)/gi, " ")
            .replace(/\bNone\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        // Loại chính ngày dd/mm ở đầu fragment trước khi lấy 8 token dữ liệu.
        const afterDate = fragment.replace(/^\d{1,2}\s*[\/.-]\s*\d{1,2}\s*/, "");
        const tokens = afterDate.match(/(?:ct|\*|-?\d+(?:[.,]\d+)?)/gi) || [];
        if (tokens.length < 8) continue;

        const forecastDate = resolveForecastDate(current.dayMonth, bulletinDate);
        if (!forecastDate) continue;

        dayRows.push({
            dayMonth: current.dayMonth,
            forecastDate,
            tokens: tokens.slice(0, 8)
        });
    }

    return dayRows;
}



// Parser chính cho bảng dự báo 2026: đọc từng DÒNG đã render theo layout.
// Đây là cách ổn định nhất với file HCMC_TVHN vì trong output thực tế mỗi hàng
// dự báo vẫn giữ nguyên dạng: [tên trạm nếu có] dd/mm H time H time H time H time.
// Không phụ thuộc vị trí tên trạm và không cắt fragment từ ngày này sang ngày khác.
function parseForecastRowsFromLayoutLines(layoutText, bulletinDate) {
    const expectedDates = Array.from({ length: 5 }, (_, i) => addDaysToIsoDate(bulletinDate, i));
    const expectedSet = new Set(expectedDates);
    const dayRows = [];

    for (const rawLine of String(layoutText || "").split(/\r?\n/)) {
        const line = rawLine.replace(/\s+/g, " ").trim();
        if (!line) continue;

        const dm = line.match(/(?:^|\s)(\d{1,2})\s*[\/. -]\s*(\d{1,2})(?=\s|$)/);
        if (!dm) continue;

        const dayMonth = `${String(Number(dm[1])).padStart(2, "0")}/${String(Number(dm[2])).padStart(2, "0")}`;
        const forecastDate = resolveForecastDate(dayMonth, bulletinDate);
        if (!forecastDate || !expectedSet.has(forecastDate)) continue;

        const digitOffset = dm[0].search(/\d/);
        const start = (dm.index || 0) + (digitOffset < 0 ? 0 : digitOffset);
        const dateText = dm[0].slice(digitOffset < 0 ? 0 : digitOffset);
        const afterDate = line.slice(start + dateText.length);
        const tokens = afterDate.match(/(?:ct|\*|-?\d+(?:[.,]\d+)?)/gi) || [];

        if (tokens.length < 8) continue;
        dayRows.push({
            dayMonth,
            forecastDate,
            tokens: tokens.slice(0, 8),
            sourceLine: line
        });
    }

    const byDate = new Map(expectedDates.map(date => [date, []]));
    for (const row of dayRows) byDate.get(row.forecastDate)?.push(row);

    const coverage = expectedDates.filter(date => (byDate.get(date)?.length || 0) > 0);
    if (coverage.length < 5) {
        throw new Error(`Line parser chỉ phủ ${coverage.length}/5 ngày (${coverage.join(", ") || "không có"}).`);
    }

    // Bản tin chuẩn có 3 trạm x 5 ngày = 15 dòng. Không bắt buộc đủ 15 để tránh
    // vỡ khi một ô bị PDF engine bỏ mất; chỉ cần đủ 5 ngày và mỗi dòng có 8 token.
    const rows = aggregateHcmcRowsFromDayRows(dayRows);
    if (!rows.length) throw new Error("Line parser không tạo được mốc triều hợp lệ.");

    console.log(`[TIDE] Layout-line parser: ${dayRows.length} dòng ngày, ${rows.length} mốc triều, đủ 5/5 ngày.`);
    return rows;
}

function selectFiveDayForecastRows(dayRows, bulletinDate) {
    const expected = Array.from({ length: 5 }, (_, i) => addDaysToIsoDate(bulletinDate, i));
    const filtered = dayRows.filter(row => expected.includes(row.forecastDate));

    // Ưu tiên đúng cấu trúc 3 trạm x 5 ngày = 15 dòng liên tục.
    for (let start = 0; start + 15 <= filtered.length; start++) {
        const window = filtered.slice(start, start + 15);
        let ok = true;
        for (let group = 0; group < 3 && ok; group++) {
            for (let i = 0; i < 5; i++) {
                if (window[group * 5 + i].forecastDate !== expected[i]) {
                    ok = false;
                    break;
                }
            }
        }
        if (ok) return window;
    }

    // Nếu text stream có xen vài dòng thừa nhưng mỗi ngày vẫn xuất hiện đủ 3 lần,
    // ghép lại theo thứ tự occurrence để giữ 3 cụm trạm.
    const byDate = new Map(expected.map(date => [date, []]));
    for (const row of filtered) byDate.get(row.forecastDate)?.push(row);
    if (expected.every(date => (byDate.get(date)?.length || 0) >= 3)) {
        const rebuilt = [];
        for (let occurrence = 0; occurrence < 3; occurrence++) {
            for (const date of expected) rebuilt.push(byDate.get(date)[occurrence]);
        }
        return rebuilt;
    }

    return filtered;
}

function stripDiacritics(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
}

function formatDateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function monthArchiveUrl(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return `${SOURCE_BASE}/index.php/${y}/${m}-${y}`;
}

function parseBulletinDateFromText(text, fallback = null) {
    const normalized = stripDiacritics(text);
    const match = normalized.match(/ngay\s+(\d{1,2})\s+thang\s+(\d{1,2})\s+nam\s+(\d{4})/);
    if (!match) return fallback;
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function parseBulletinDateFromUrl(url) {
    // Chấp nhận cả tên file có hậu tố do website/Windows đổi tên, ví dụ:
    // HCMC_TVHN_20260904.pdf, HCMC_TVHN_20260904__1_.pdf, ...
    const match = String(url).match(/HCMC[_-]?TVHN[_-]?(\d{4})(\d{2})(\d{2})(?=\D|$)/i);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseLevel(token) {
    if (!token) return null;
    if (/^(ct|\*|-)$/.test(String(token).trim().toLowerCase())) return null;
    const n = Number(String(token).replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

function parseTime(token) {
    if (!token) return null;
    const cleaned = String(token).trim().toLowerCase();
    if (/^(ct|\*|-)$/.test(cleaned)) return null;
    const match = cleaned.match(/^(\d{1,2})[.:](\d{1,2})$/);
    if (!match) return null;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}

function resolveForecastDate(dayMonth, bulletinDate) {
    const [day, month] = dayMonth.split("/").map(Number);
    const base = new Date(`${bulletinDate}T00:00:00`);
    if (!Number.isFinite(day) || !Number.isFinite(month) || Number.isNaN(base.getTime())) return null;

    let year = base.getFullYear();
    const baseMonth = base.getMonth() + 1;
    if (baseMonth === 12 && month === 1) year += 1;
    if (baseMonth === 1 && month === 12) year -= 1;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractRowsFromBlock(blockText, stationKey, bulletinDate) {
    const rows = [];
    const matches = findForecastDateMatches(blockText);

    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : blockText.length;
        const fragment = blockText.slice(start, end)
            .replace(/\|/g, " ")
            .replace(/MỰC NƯỚC DỰ BÁO\s*\(m\)/gi, " ")
            .replace(/\bNone\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        const dayMonth = matches[i].dayMonth;
        const afterDate = fragment.replace(/^\d{1,2}\s*[\/.-]\s*\d{1,2}\s*/, "");
        const tokens = afterDate.match(/(?:ct|\*|-?\d+(?:[.,]\d+)?)/gi) || [];
        if (tokens.length < 8) continue;

        const [h1, t1, h2, t2, l1, lt1, l2, lt2] = tokens.slice(0, 8);
        const forecastDate = resolveForecastDate(dayMonth, bulletinDate);
        if (!forecastDate) continue;

        const events = [
            { eventType: "HIGH", eventIndex: 1, level: parseLevel(h1), time: parseTime(t1) },
            { eventType: "HIGH", eventIndex: 2, level: parseLevel(h2), time: parseTime(t2) },
            { eventType: "LOW", eventIndex: 1, level: parseLevel(l1), time: parseTime(lt1) },
            { eventType: "LOW", eventIndex: 2, level: parseLevel(l2), time: parseTime(lt2) }
        ];

        for (const event of events) {
            if (event.level == null || event.time == null) continue;
            rows.push({
                station: stationKey,
                forecastDate,
                eventType: event.eventType,
                eventIndex: event.eventIndex,
                levelM: event.level,
                eventTime: event.time
            });
        }
    }
    return rows;
}

function parseForecastRows(text, bulletinDate) {
    const raw = String(text || "");
    const normalizedRaw = stripDiacritics(raw);
    const markerIndex = normalizedRaw.indexOf("muc nuoc du bao");
    if (markerIndex < 0) throw new Error("Không tìm thấy bảng MỰC NƯỚC DỰ BÁO trong PDF.");

    let forecastText = raw.slice(markerIndex);
    const warningIndex = stripDiacritics(forecastText).indexOf("canh bao");
    if (warningIndex > 0) forecastText = forecastText.slice(0, warningIndex);

    const normalized = stripDiacritics(forecastText);
    const stationPositions = [];

    // Cách 1: PDF giữ đúng tên trạm trong phần text của bảng.
    for (const station of TRACKED_STATIONS) {
        let best = -1;
        for (const name of station.names.map(stripDiacritics)) {
            const idx = normalized.indexOf(name);
            if (idx >= 0 && (best < 0 || idx < best)) best = idx;
        }
        if (best >= 0) stationPositions.push({ station: station.key, index: best });
    }

    stationPositions.sort((a, b) => a.index - b.index);

    if (stationPositions.length) {
        const rows = [];
        for (let i = 0; i < stationPositions.length; i++) {
            const current = stationPositions[i];
            const end = i + 1 < stationPositions.length ? stationPositions[i + 1].index : forecastText.length;
            const block = forecastText.slice(current.index, end);
            rows.push(...extractRowsFromBlock(block, current.station, bulletinDate));
        }

        // Chỉ dùng cách tách theo tên trạm khi mỗi trạm thật sự có đủ 5 ngày.
        // Một số bộ trích PDF đặt tên trạm giữa cụm 5 dòng, khiến cách này mất 1-2 ngày đầu.
        const datesByStation = new Map();
        for (const row of rows) {
            if (!datesByStation.has(row.station)) datesByStation.set(row.station, new Set());
            datesByStation.get(row.station).add(row.forecastDate);
        }
        const stationBlocksComplete = TRACKED_STATIONS.every(station =>
            (datesByStation.get(station.key)?.size || 0) >= 5
        );

        if (stationBlocksComplete && rows.length >= 8) return rows;
    }

    // Cách 2 (fallback cho bản tin 2026): pdf-parse có thể làm mất tên trạm
    // ở cột đầu của bảng và dồn "Phú An / Nhà Bè / Thủ Dầu Một" xuống cuối trang.
    // Khi đó vẫn còn 15 dòng dự báo theo thứ tự cố định: 5 ngày Phú An,
    // 5 ngày Nhà Bè, 5 ngày Thủ Dầu Một. Ta tách các dòng theo ngày rồi gán nhóm.
    let dayRows = extractForecastDayRowsFromText(forecastText, bulletinDate);

    // Một số PDF khi qua pdf.js đặt header "MỰC NƯỚC DỰ BÁO" sau phần số liệu
    // trong text stream. Khi đó phần forecastText không còn ngày; thử lại trên toàn trang.
    if (!dayRows.length) {
        dayRows = extractForecastDayRowsFromText(raw, bulletinDate);
    }

    dayRows = selectFiveDayForecastRows(dayRows, bulletinDate);

    if (!dayRows.length) {
        throw new Error("Không tìm thấy các dòng ngày trong bảng dự báo triều sau khi đã thử parser theo tọa độ và toàn trang.");
    }

    if (dayRows.length < 5) {
        throw new Error(`Đã đọc PDF nhưng chỉ tìm được ${dayRows.length} dòng dự báo hợp lệ.`);
    }

    // Nếu đủ đúng 15 dòng (3 trạm x 5 ngày), giữ cách gán theo từng cụm trạm.
    // Nếu bộ trích PDF chỉ lấy được một phần dòng hoặc làm lẫn thứ tự, KHÔNG gán cứng
    // 5 dòng đầu là Phú An vì có thể tạo trùng khóa/sai trạm. Khi đó ta tổng hợp trực tiếp
    // theo ngày thành một chuỗi đại diện "TP_HCM": lấy đỉnh cao nhất và chân thấp nhất
    // trong các dòng đọc được của cùng ngày. Cách này phù hợp với Dashboard chỉ hiển thị
    // "Triều TP.HCM" de hien thi tham khao tren Dashboard.
    const rows = [];

    if (dayRows.length >= 15) {
        const stationOrder = ["PHU_AN", "NHA_BE", "THU_DAU_MOT"];
        for (let group = 0; group < stationOrder.length; group++) {
            const groupRows = dayRows.slice(group * 5, group * 5 + 5);
            if (groupRows.length < 5) continue;

            for (const item of groupRows) {
                const [h1, t1, h2, t2, l1, lt1, l2, lt2] = item.tokens;
                const events = [
                    { eventType: "HIGH", eventIndex: 1, level: parseLevel(h1), time: parseTime(t1) },
                    { eventType: "HIGH", eventIndex: 2, level: parseLevel(h2), time: parseTime(t2) },
                    { eventType: "LOW", eventIndex: 1, level: parseLevel(l1), time: parseTime(lt1) },
                    { eventType: "LOW", eventIndex: 2, level: parseLevel(l2), time: parseTime(lt2) }
                ];

                for (const event of events) {
                    if (event.level == null || event.time == null) continue;
                    rows.push({
                        station: stationOrder[group],
                        forecastDate: item.forecastDate,
                        eventType: event.eventType,
                        eventIndex: event.eventIndex,
                        levelM: event.level,
                        eventTime: event.time
                    });
                }
            }
        }
        console.log(`[TIDE] Parser fallback 2026: ${dayRows.length} dòng ngày, ${rows.length} mốc triều.`);
    } else {
        const byDate = new Map();
        for (const item of dayRows) {
            if (!byDate.has(item.forecastDate)) byDate.set(item.forecastDate, []);
            byDate.get(item.forecastDate).push(item);
        }

        for (const [forecastDate, items] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const slots = { H1: [], H2: [], L1: [], L2: [] };
            for (const item of items) {
                const [h1, t1, h2, t2, l1, lt1, l2, lt2] = item.tokens;
                const candidates = [
                    ["H1", parseLevel(h1), parseTime(t1)],
                    ["H2", parseLevel(h2), parseTime(t2)],
                    ["L1", parseLevel(l1), parseTime(lt1)],
                    ["L2", parseLevel(l2), parseTime(lt2)]
                ];
                for (const [slot, level, time] of candidates) {
                    if (level == null || time == null) continue;
                    slots[slot].push({ level, time });
                }
            }

            const pickHigh = list => list.reduce((best, x) => !best || x.level > best.level ? x : best, null);
            const pickLow = list => list.reduce((best, x) => !best || x.level < best.level ? x : best, null);
            const selected = [
                { eventType: "HIGH", eventIndex: 1, value: pickHigh(slots.H1) },
                { eventType: "HIGH", eventIndex: 2, value: pickHigh(slots.H2) },
                { eventType: "LOW", eventIndex: 1, value: pickLow(slots.L1) },
                { eventType: "LOW", eventIndex: 2, value: pickLow(slots.L2) }
            ];

            for (const event of selected) {
                if (!event.value) continue;
                rows.push({
                    station: "TP_HCM",
                    forecastDate,
                    eventType: event.eventType,
                    eventIndex: event.eventIndex,
                    levelM: event.value.level,
                    eventTime: event.value.time
                });
            }
        }
        console.log(`[TIDE] Parser TP.HCM aggregate: ${dayRows.length} dòng ngày, ${rows.length} mốc triều.`);
    }

    if (rows.length < 4) {
        throw new Error(`Đã đọc PDF nhưng chỉ trích được ${rows.length} mốc triều; cấu trúc bản tin có thể đã thay đổi.`);
    }

    return rows;
}

function extractPdfCandidates(html, pageUrl) {
    const $ = cheerio.load(html);
    const candidates = [];

    $("a[href]").each((_, element) => {
        const href = $(element).attr("href");
        if (!href) return;
        const label = `${$(element).text()} ${href}`;
        if (!/\.pdf(?:$|\?)/i.test(href) && !/download=/i.test(href)) return;
        if (!/HCMC[_-]?TVHN|thuy\s*trieu|thu[yỷ]\s*tri[eề]u|ban.?tin.?ngay/i.test(stripDiacritics(label))) return;

        try {
            const url = new URL(href, pageUrl).toString();
            let date = parseBulletinDateFromUrl(url) || parseBulletinDateFromText(label, null);
            if (!date) {
                const dmY = stripDiacritics(label).match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
                if (dmY) date = `${dmY[3]}-${String(dmY[2]).padStart(2, "0")}-${String(dmY[1]).padStart(2, "0")}`;
            }
            candidates.push({ url, date, label: $(element).text().trim() });
        } catch (_) {}
    });

    return candidates;
}

async function discoverLatestBulletin() {
    const now = new Date();
    const all = [];

    for (let offset = 0; offset < ARCHIVE_MONTH_LOOKBACK; offset++) {
        const month = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        const pageUrl = monthArchiveUrl(month);
        try {
            const response = await HTTP.get(pageUrl, { responseType: "text" });
            all.push(...extractPdfCandidates(response.data, pageUrl));
        } catch (error) {
            // Trang tháng có thể chưa tồn tại; tiếp tục lùi về tháng trước.
        }
    }

    const unique = new Map();
    for (const item of all) unique.set(item.url, item);
    const candidates = [...unique.values()];
    candidates.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

    if (candidates.length) return candidates[0];

    // Fallback: kiểm tra URL chuẩn cho vài ngày gần nhất. Không quét quá nhiều request.
    for (let back = 0; back < 14; back++) {
        const date = new Date(now);
        date.setDate(now.getDate() - back);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        const url = `${SOURCE_BASE}/phocadownload/${y}/${m}-${y}/HCMC_TVHN_${y}${m}${d}.pdf`;
        try {
            const response = await HTTP.get(url, { responseType: "arraybuffer", maxContentLength: 12 * 1024 * 1024 });
            const type = String(response.headers["content-type"] || "").toLowerCase();
            if (response.status === 200 && (type.includes("pdf") || Buffer.from(response.data).slice(0, 4).toString() === "%PDF")) {
                return { url, date: `${y}-${m}-${d}`, label: `Bản tin ngày ${d}-${m}-${y}`, prefetchedBuffer: Buffer.from(response.data) };
            }
        } catch (_) {}
    }

    throw new Error("Không tìm thấy bản tin thủy triều TP.HCM trên nguồn chính thức trong phạm vi dò tự động.");
}

async function bulletinAlreadyStored(sourceUrl) {
    const [rows] = await pool.execute(
        "SELECT id, bulletin_date, fetched_at, parse_status, parse_message FROM tide_bulletins WHERE source_url = ? LIMIT 1",
        [sourceUrl]
    );
    return rows[0] || null;
}

async function storeBulletin(bulletinDate, sourceUrl, rows) {
    // Chặn dữ liệu trùng ngay trước khi ghi DB. Nếu cùng khóa xuất hiện nhiều lần do PDF
    // bị trích lặp, HIGH giữ mức cao hơn, LOW giữ mức thấp hơn.
    const unique = new Map();
    for (const row of rows) {
        const key = `${row.station}|${row.forecastDate}|${row.eventType}|${row.eventIndex}`;
        const old = unique.get(key);
        if (!old) {
            unique.set(key, row);
            continue;
        }
        const replace = row.eventType === "HIGH"
            ? Number(row.levelM) > Number(old.levelM)
            : Number(row.levelM) < Number(old.levelM);
        if (replace) unique.set(key, row);
    }
    rows = [...unique.values()];

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
            `INSERT INTO tide_bulletins (bulletin_date, source_url, fetched_at, parse_status, parse_message)
             VALUES (?, ?, NOW(3), 'OK', ?)
             ON DUPLICATE KEY UPDATE bulletin_date = VALUES(bulletin_date), fetched_at = NOW(3), parse_status = 'OK', parse_message = VALUES(parse_message)`,
            [bulletinDate, sourceUrl, `Trích tự động ${rows.length} mốc triều.`]
        );

        let bulletinId = result.insertId;
        if (!bulletinId) {
            const [existing] = await connection.execute("SELECT id FROM tide_bulletins WHERE source_url = ? LIMIT 1", [sourceUrl]);
            bulletinId = existing[0].id;
            await connection.execute("DELETE FROM tide_forecasts WHERE bulletin_id = ?", [bulletinId]);
        }

        for (const row of rows) {
            await connection.execute(
                `INSERT INTO tide_forecasts
                 (bulletin_id, station, forecast_date, event_type, event_index, level_m, event_time)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE level_m = VALUES(level_m), event_time = VALUES(event_time)`,
                [bulletinId, row.station, row.forecastDate, row.eventType, row.eventIndex, row.levelM, row.eventTime]
            );
        }

        await connection.commit();
        return bulletinId;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function logFailedParse(sourceUrl, bulletinDate, error) {
    try {
        await pool.execute(
            `INSERT INTO tide_bulletins (bulletin_date, source_url, fetched_at, parse_status, parse_message)
             VALUES (?, ?, NOW(3), 'ERROR', ?)
             ON DUPLICATE KEY UPDATE fetched_at = NOW(3), parse_status = 'ERROR', parse_message = VALUES(parse_message)`,
            [bulletinDate || null, sourceUrl, String(error.message || error).slice(0, 500)]
        );
    } catch (_) {}
}

async function refreshTideData({ force = false } = {}) {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        const discovered = await discoverLatestBulletin();
        const existing = await bulletinAlreadyStored(discovered.url);
        // Chỉ bỏ qua khi bản tin trước đó đã parse OK. Nếu lần cũ ERROR,
        // phiên bản parser mới phải tự thử lại ngay khi backend khởi động.
        if (existing && existing.parse_status === "OK" && !force) {
            const archivedPdf = await ensurePdfArchive(discovered);
            lastRefreshResult = {
                ok: true,
                updated: false,
                sourceUrl: discovered.url,
                bulletinDate: discovered.date || existing.bulletin_date,
                archivedPdf,
                message: archivedPdf
                    ? `Bản tin mới nhất đã có trong MySQL. PDF lưu tại ${archivedPdf}.`
                    : "Bản tin mới nhất đã có trong MySQL."
            };
            return lastRefreshResult;
        }

        let buffer = discovered.prefetchedBuffer;
        if (!buffer) {
            const response = await HTTP.get(discovered.url, { responseType: "arraybuffer", maxContentLength: 12 * 1024 * 1024 });
            buffer = Buffer.from(response.data);
        }

        // Lưu file gốc trước khi parse để vẫn có bằng chứng nguồn ngay cả khi cấu trúc PDF thay đổi.
        const archivedPdf = await savePdfArchive(buffer, discovered);

        try {
            const fallbackDate = discovered.date || formatDateLocal(new Date());

            // Lần 1: render theo tọa độ X/Y để giữ từng hàng của bảng PDF.
            const layoutParsed = await pdfParse(buffer, { pagerender: renderPageLayout });
            // Lần 2: giữ parser mặc định làm nguồn dự phòng cho phần tiêu đề/ngày bản tin.
            let defaultParsed = null;
            try {
                defaultParsed = await pdfParse(buffer);
            } catch (_) {}

            const bulletinDate = parseBulletinDateFromText(
                `${layoutParsed.text || ""}\n${defaultParsed?.text || ""}`,
                fallbackDate
            );

            let lineRows = null;
            try {
                lineRows = parseForecastRowsFromLayoutLines(layoutParsed.text, bulletinDate);
            } catch (lineError) {
                console.warn(`[TIDE] Layout-line parser fallback: ${lineError.message || lineError}`);
            }

            let coordinateRows = null;
            try {
                const tokenParsed = await pdfParse(buffer, { pagerender: renderPageTokenDump });
                coordinateRows = parseForecastRowsFromTokenDump(tokenParsed.text, bulletinDate);
            } catch (coordinateError) {
                console.warn(`[TIDE] Coordinate parser fallback: ${coordinateError.message || coordinateError}`);
            }

            let rows = null;
            let lastParseError = null;
            const textCandidates = [
                { name: "layout", text: layoutParsed.text },
                { name: "default", text: defaultParsed?.text }
            ].filter(item => item.text);

            // Không dừng ở parser đầu tiên chỉ vì nó đọc được *một phần* bảng.
            // Với một số PDF 2026, renderer theo tọa độ chỉ lấy được 8/15 dòng,
            // trong khi parser mặc định vẫn giữ đủ 5 ngày. Ta parse TẤT CẢ ứng viên
            // rồi chọn kết quả có độ phủ ngày tốt nhất.
            const parsedCandidates = [];

            if (lineRows?.length) {
                const dates = [...new Set(lineRows.map(r => String(r.forecastDate).slice(0, 10)))].sort();
                parsedCandidates.push({ name: "layout-line", rows: lineRows, dateCount: dates.length, coverageEnd: dates.at(-1) || null });
            }

            if (coordinateRows?.length) {
                const dates = [...new Set(coordinateRows.map(r => String(r.forecastDate).slice(0, 10)))].sort();
                parsedCandidates.push({ name: "coordinate-table", rows: coordinateRows, dateCount: dates.length, coverageEnd: dates.at(-1) || null });
            }

            for (const candidate of textCandidates) {
                try {
                    const candidateRows = parseForecastRows(candidate.text, bulletinDate);
                    if (!candidateRows?.length) continue;

                    const dates = [...new Set(candidateRows.map(r => String(r.forecastDate).slice(0, 10)))].sort();
                    const coverageEnd = dates.at(-1) || null;
                    parsedCandidates.push({
                        name: candidate.name,
                        rows: candidateRows,
                        dateCount: dates.length,
                        coverageEnd
                    });
                } catch (error) {
                    lastParseError = error;
                }
            }

            parsedCandidates.sort((a, b) =>
                (b.dateCount - a.dateCount) ||
                String(b.coverageEnd || "").localeCompare(String(a.coverageEnd || "")) ||
                (b.rows.length - a.rows.length)
            );

            const best = parsedCandidates[0] || null;
            if (!best) {
                throw lastParseError || new Error("Không trích được dữ liệu dự báo triều từ PDF.");
            }

            const expectedCoverageEnd = addDaysToIsoDate(bulletinDate, 4);
            if (best.dateCount < 5 || !best.coverageEnd || best.coverageEnd < expectedCoverageEnd) {
                throw new Error(
                    `Parser chỉ đọc được ${best.dateCount}/5 ngày (đến ${best.coverageEnd || "không xác định"}); ` +
                    `bản tin phải phủ đến ${expectedCoverageEnd}. Không lưu dữ liệu thiếu vào MySQL.`
                );
            }

            rows = best.rows;
            console.log(`[TIDE] Chọn parser ${best.name}: ${best.dateCount}/5 ngày, phủ đến ${best.coverageEnd}, ${rows.length} mốc triều.`);

            await storeBulletin(bulletinDate, discovered.url, rows);

            lastRefreshResult = {
                ok: true,
                updated: true,
                sourceUrl: discovered.url,
                bulletinDate,
                rows: rows.length,
                archivedPdf,
                message: archivedPdf
                    ? `Đã cập nhật tự động ${rows.length} mốc thủy triều. PDF: ${archivedPdf}.`
                    : `Đã cập nhật tự động ${rows.length} mốc thủy triều.`
            };
            console.log(`[TIDE] ${lastRefreshResult.message} Bulletin: ${bulletinDate}`);
            return lastRefreshResult;
        } catch (error) {
            try {
                // Nếu parser vẫn gặp một định dạng PDF mới, lưu text đã render để debug
                // mà không cần người dùng cài thêm công cụ ngoài.
                const debugParsed = await pdfParse(buffer, { pagerender: renderPageLayout });
                const debugPath = await saveParseDebug(debugParsed.text, discovered);
                if (debugPath) console.warn(`[TIDE] Parse debug saved: ${debugPath}`);
            } catch (_) {}
            await logFailedParse(discovered.url, discovered.date, error);
            throw error;
        }
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

function vietnamNow() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`);
}


function addDaysToIsoDate(dateString, days) {
    // dateString là ngày lịch tại Việt Nam (YYYY-MM-DD), không phải một thời điểm UTC.
    // Bản cũ tạo 00:00 +07 rồi dùng setUTCDate(), khiến ngày bị lùi 1 ngày
    // (ví dụ 04/09 + 4 ngày thành 07/09 thay vì 08/09).
    const match = String(dateString || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return dateString;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(date.getTime())) return dateString;

    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toISOString().slice(0, 10);
}

function vietnamDateString(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric", month: "2-digit", day: "2-digit"
    }).format(date);
}

function riskBandForPeak(level) {
    if (level == null) return { code: "UNKNOWN", label: "Chưa xác định", className: "secondary" };
    if (level >= 1.60) return { code: "BD3", label: "Rất cao (≥ BĐ III)", className: "danger" };
    if (level >= 1.50) return { code: "BD2", label: "Cao (≥ BĐ II)", className: "warning" };
    if (level >= 1.40) return { code: "BD1", label: "Theo dõi (≥ BĐ I)", className: "info" };
    return { code: "BELOW_BD1", label: "Dưới BĐ I", className: "success" };
}


// Cache ngắn cho API mobile/site. Dữ liệu triều chỉ thay đổi khi có bản tin mới,
// nên không cần truy vấn MySQL ở mỗi lần app refresh trạng thái.
const siteTideCache = new Map();
const SITE_TIDE_CACHE_MS = Number(process.env.SITE_TIDE_CACHE_MS || 60000);

function localEventDateTime(forecastDate, eventTime, effectiveDate = forecastDate) {
    const date = String(effectiveDate || forecastDate || "").slice(0, 10);
    const time = String(eventTime || "00:00:00").slice(0, 8);
    const value = new Date(`${date}T${time}+07:00`);
    return Number.isNaN(value.getTime()) ? null : value;
}

function resolveEffectiveEventDate(row, firstEventTimeByType) {
    const forecastDate = String(row.forecast_date).slice(0, 10);
    const eventTime = String(row.event_time).slice(0, 8);
    const eventIndex = Number(row.event_index);
    const firstTime = firstEventTimeByType.get(`${row.event_type}|${forecastDate}`);

    // Bản tin có thể ghi mốc thứ 2 sau 00:00 nhưng vẫn thuộc chuỗi ngày dự báo hôm trước.
    if (eventIndex === 2 && firstTime && eventTime < firstTime) {
        return addDaysToIsoDate(forecastDate, 1);
    }
    return forecastDate;
}

function formatTideEvent(row, effectiveDate, nowMs) {
    const at = localEventDateTime(row.forecast_date, row.event_time, effectiveDate);
    if (!at) return null;

    const levelM = Number(row.level_m);
    return {
        date: String(effectiveDate).slice(0, 10),
        source_forecast_date: String(row.forecast_date).slice(0, 10),
        type: row.event_type,
        event_index: Number(row.event_index),
        level_m: Number.isFinite(levelM) ? levelM : null,
        time: String(row.event_time).slice(0, 8),
        minutes_from_now: Math.round((at.getTime() - nowMs) / 60000)
    };
}

/**
 * Lấy dữ liệu triều dành riêng cho một địa điểm.
 * Không thay đổi /api/tide/hcmc để tránh ảnh hưởng Dashboard hiện tại.
 *
 * Lưu ý: bản tin hiện lưu các mốc HIGH/LOW, không lưu mực nước triều tức thời.
 * Vì vậy `phase` là xu thế suy ra từ mốc trước -> mốc kế tiếp, không phải phép đo trực tiếp.
 */
async function getSiteTideSummary(siteId, stationOverride = null) {
    const parsedSiteId = Number(siteId);
    if (!Number.isInteger(parsedSiteId) || parsedSiteId <= 0) {
        return { available: false, reason: "INVALID_SITE_ID" };
    }

    let station = stationOverride ? String(stationOverride).trim() : "";
    if (!station) {
        const [siteRows] = await pool.execute(
            "SELECT tide_station FROM monitoring_sites WHERE site_id = ? LIMIT 1",
            [parsedSiteId]
        );
        station = siteRows.length ? String(siteRows[0].tide_station || "").trim() : "";
    }

    if (!station) {
        return {
            available: false,
            station: null,
            message: "Địa điểm chưa được gán trạm triều."
        };
    }

    const cacheKey = `${parsedSiteId}|${station}`;
    const cached = siteTideCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < SITE_TIDE_CACHE_MS) {
        return cached.value;
    }

    const [bulletins] = await pool.query(
        `SELECT id, DATE_FORMAT(bulletin_date, '%Y-%m-%d') AS bulletin_date,
                source_url, fetched_at, parse_status, parse_message
         FROM tide_bulletins
         WHERE parse_status = 'OK'
         ORDER BY bulletin_date DESC, fetched_at DESC
         LIMIT 1`
    );

    if (!bulletins.length) {
        const value = {
            available: false,
            station,
            stale: true,
            message: "Chưa có bản tin triều hợp lệ trong MySQL."
        };
        siteTideCache.set(cacheKey, { at: Date.now(), value });
        return value;
    }

    const requestedStation = station;
    let dataStation = station;
    let fallbackSource = null;
    let bulletin = bulletins[0];

    const loadRows = async (bulletinId, stationKey) => {
        const [result] = await pool.execute(
            `SELECT DATE_FORMAT(forecast_date, '%Y-%m-%d') AS forecast_date,
                    station, event_type, event_index, level_m,
                    TIME_FORMAT(event_time, '%H:%i:%s') AS event_time
             FROM tide_forecasts
             WHERE bulletin_id = ? AND station = ?
             ORDER BY forecast_date, event_time, event_type DESC, event_index`,
            [bulletinId, stationKey]
        );
        return result;
    };

    let rows = await loadRows(bulletin.id, dataStation);

    // Parser hiện tại có thể tổng hợp 3 trạm thành chuỗi TP_HCM (20 mốc / 5 ngày).
    // Nếu site đang gán THU_DAU_MOT/PHU_AN/NHA_BE mà bản tin mới chỉ có TP_HCM,
    // dùng ngay chuỗi tổng hợp của CÙNG bản tin thay vì trả về rỗng.
    if (!rows.length && dataStation !== "TP_HCM") {
        const aggregateRows = await loadRows(bulletin.id, "TP_HCM");
        if (aggregateRows.length) {
            rows = aggregateRows;
            dataStation = "TP_HCM";
            fallbackSource = "TP_HCM_AGGREGATE_CURRENT_BULLETIN";
        }
    }

    // Nếu bản tin mới không có cả trạm yêu cầu lẫn chuỗi TP_HCM,
    // tìm bản tin gần nhất còn dữ liệu cho trạm yêu cầu.
    if (!rows.length) {
        const [stationBulletins] = await pool.execute(
            `SELECT DISTINCT tb.id,
                    DATE_FORMAT(tb.bulletin_date, '%Y-%m-%d') AS bulletin_date,
                    tb.source_url, tb.fetched_at, tb.parse_status, tb.parse_message
             FROM tide_bulletins tb
             JOIN tide_forecasts tf ON tf.bulletin_id = tb.id
             WHERE tb.parse_status = 'OK' AND tf.station = ?
             ORDER BY tb.bulletin_date DESC, tb.fetched_at DESC
             LIMIT 1`,
            [requestedStation]
        );

        if (stationBulletins.length) {
            bulletin = stationBulletins[0];
            dataStation = requestedStation;
            rows = await loadRows(bulletin.id, dataStation);
            if (rows.length) fallbackSource = "LATEST_REQUESTED_STATION_BULLETIN";
        }
    }

    // Fallback cuối: lấy chuỗi TP_HCM gần nhất có trong MySQL.
    if (!rows.length) {
        const [aggregateBulletins] = await pool.execute(
            `SELECT DISTINCT tb.id,
                    DATE_FORMAT(tb.bulletin_date, '%Y-%m-%d') AS bulletin_date,
                    tb.source_url, tb.fetched_at, tb.parse_status, tb.parse_message
             FROM tide_bulletins tb
             JOIN tide_forecasts tf ON tf.bulletin_id = tb.id
             WHERE tb.parse_status = 'OK' AND tf.station = 'TP_HCM'
             ORDER BY tb.bulletin_date DESC, tb.fetched_at DESC
             LIMIT 1`
        );

        if (aggregateBulletins.length) {
            bulletin = aggregateBulletins[0];
            dataStation = "TP_HCM";
            rows = await loadRows(bulletin.id, dataStation);
            if (rows.length) fallbackSource = "LATEST_TP_HCM_AGGREGATE";
        }
    }

    if (!rows.length) {
        const value = {
            available: false,
            station,
            stale: true,
            bulletin_date: String(bulletin.bulletin_date).slice(0, 10),
            source_url: bulletin.source_url,
            fetched_at: bulletin.fetched_at,
            message: `MySQL chưa có mốc triều HIGH/LOW cho trạm ${requestedStation} hoặc chuỗi tổng hợp TP_HCM.`
        };
        siteTideCache.set(cacheKey, { at: Date.now(), value });
        return value;
    }

    const firstEventTimeByType = new Map();
    for (const row of rows) {
        const key = `${row.event_type}|${String(row.forecast_date).slice(0, 10)}`;
        if (!firstEventTimeByType.has(key)) {
            firstEventTimeByType.set(key, String(row.event_time).slice(0, 8));
        }
    }

    const now = vietnamNow();
    const nowMs = now.getTime();
    const events = [];

    for (const row of rows) {
        const effectiveDate = resolveEffectiveEventDate(row, firstEventTimeByType);
        const event = formatTideEvent(row, effectiveDate, nowMs);
        if (!event) continue;
        const at = localEventDateTime(row.forecast_date, row.event_time, effectiveDate);
        events.push({ ...event, _at: at });
    }

    events.sort((a, b) => a._at - b._at);

    const previous = [...events].reverse().find(event => event._at.getTime() <= nowMs) || null;
    const next = events.find(event => event._at.getTime() > nowMs) || null;
    const nextHigh = events.find(event => event._at.getTime() > nowMs && event.type === "HIGH") || null;
    const nextLow = events.find(event => event._at.getTime() > nowMs && event.type === "LOW") || null;

    const highEvents = events.filter(event => event.type === "HIGH");
    const previousHigh = [...highEvents].reverse()
        .find(event => event._at.getTime() <= nowMs) || null;

    // Giá trị dùng để hiển thị luôn có số liệu khi MySQL còn ít nhất một mốc HIGH:
    // ưu tiên đỉnh kế tiếp; nếu cửa sổ dự báo đã qua thì giữ đỉnh HIGH gần nhất.
    const displayHigh = nextHigh || previousHigh || highEvents[0] || null;

    const forecastDates = rows.map(row => String(row.forecast_date).slice(0, 10)).sort();
    const forecastCoverageEnd = forecastDates.at(-1) || null;
    const today = vietnamDateString();
    const stale = !forecastCoverageEnd || today > forecastCoverageEnd;

    let phase = "UNKNOWN";
    let phaseLabel = "Chưa xác định";
    let phaseBasis = "Không đủ mốc HIGH/LOW để suy ra xu thế.";

    if (previous && next) {
        if (Number(next.level_m) > Number(previous.level_m)) {
            phase = "RISING";
            phaseLabel = "Đang lên";
        } else if (Number(next.level_m) < Number(previous.level_m)) {
            phase = "FALLING";
            phaseLabel = "Đang xuống";
        } else if (next.type === "HIGH") {
            phase = "RISING";
            phaseLabel = "Đang lên";
        } else {
            phase = "FALLING";
            phaseLabel = "Đang xuống";
        }
        phaseBasis = "Suy ra từ mốc triều trước và mốc kế tiếp trong bản tin.";
    } else if (next) {
        phase = next.type === "HIGH" ? "RISING" : "FALLING";
        phaseLabel = next.type === "HIGH" ? "Đang lên" : "Đang xuống";
        phaseBasis = "Suy ra từ mốc triều kế tiếp vì chưa có mốc trước trong cửa sổ dữ liệu.";
    }

    const cleanEvent = event => {
        if (!event) return null;
        const { _at, ...rest } = event;
        return rest;
    };

    const value = {
        available: true,
        station: dataStation,
        requested_station: requestedStation,
        fallback_source: fallbackSource,
        bulletin_date: String(bulletin.bulletin_date).slice(0, 10),
        fetched_at: bulletin.fetched_at,
        source_url: bulletin.source_url,
        source_label: "Bản tin thủy triều TP.HCM - nguồn công bố chính thức",
        stale,
        forecast_coverage_end: forecastCoverageEnd,
        phase,
        phase_label: phaseLabel,
        phase_basis: phaseBasis,
        previous_event: cleanEvent(previous),
        next_event: cleanEvent(next),
        next_high: cleanEvent(nextHigh),
        next_low: cleanEvent(nextLow),
        display_high: cleanEvent(displayHigh),
        display_high_is_next: Boolean(nextHigh),
        message: stale
            ? `Cửa sổ dự báo của bản tin đã hết hạn (đến ${forecastCoverageEnd}); dữ liệu chỉ dùng để tham khảo.`
            : `Trạm ${station} còn dữ liệu dự báo đến ${forecastCoverageEnd}.`
    };

    siteTideCache.set(cacheKey, { at: Date.now(), value });
    return value;
}

async function getHcmcTideSummary() {
    const [bulletins] = await pool.query(
        `SELECT id, DATE_FORMAT(bulletin_date, '%Y-%m-%d') AS bulletin_date, source_url, fetched_at, parse_status, parse_message
         FROM tide_bulletins
         WHERE parse_status = 'OK'
         ORDER BY bulletin_date DESC, fetched_at DESC
         LIMIT 1`
    );

    if (!bulletins.length) {
        return {
            available: false,
            stale: true,
            message: "Chưa có dữ liệu triều trong MySQL. Backend sẽ tự thử tải bản tin chính thức.",
            lastRefresh: lastRefreshResult
        };
    }

    const bulletin = bulletins[0];
    const [rows] = await pool.execute(
        `SELECT DATE_FORMAT(forecast_date, '%Y-%m-%d') AS forecast_date, station, event_type, event_index, level_m,
                TIME_FORMAT(event_time, '%H:%i:%s') AS event_time
         FROM tide_forecasts
         WHERE bulletin_id = ?
         ORDER BY forecast_date, station, event_type DESC, event_index`,
        [bulletin.id]
    );

    const dailyMap = new Map();
    const firstHighTime = new Map();

    for (const row of rows) {
        if (row.event_type !== "HIGH" || Number(row.event_index) !== 1) continue;
        const date = String(row.forecast_date).slice(0, 10);
        const key = `${row.station}|${date}`;
        firstHighTime.set(key, String(row.event_time).slice(0, 8));
    }

    const highEvents = [];
    for (const row of rows) {
        const date = String(row.forecast_date).slice(0, 10);
        if (row.event_type !== "HIGH") continue;

        const level = Number(row.level_m);
        const time = String(row.event_time).slice(0, 8);
        const eventIndex = Number(row.event_index);
        const key = `${row.station}|${date}`;
        const firstTime = firstHighTime.get(key);

        // Trong bản tin 5 ngày, đỉnh triều thứ 2 có thể rơi sau 00:00 của ngày kế tiếp
        // nhưng vẫn được in trên cùng dòng ngày dự báo. Nếu giờ đỉnh 2 nhỏ hơn giờ đỉnh 1,
        // ta chuyển ngày hiệu lực sang ngày kế tiếp để tính countdown chính xác.
        let effectiveDate = date;
        if (eventIndex === 2 && firstTime && time < firstTime) {
            effectiveDate = addDaysToIsoDate(date, 1);
        }

        highEvents.push({
            date,
            effectiveDate,
            time,
            levelM: level,
            station: row.station,
            eventIndex
        });

        const current = dailyMap.get(date);
        if (!current || level > current.peakLevelM) {
            dailyMap.set(date, { date, peakLevelM: level, peakTime: time });
        }
    }

    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const now = vietnamNow();
    const nowMs = now.getTime();

    // Dashboard đang hiển thị một đỉnh đại diện cho mỗi ngày trong bảng `daily`.
    // Vì dữ liệu đã được tổng hợp thành TP_HCM, không dùng event_index để tự cộng ngày
    // cho thẻ "đỉnh tiếp theo"; việc đó có thể làm 04:55 của 08/09 bị gán sang 09/09.
    // Thay vào đó, chọn đúng mốc tương lai kế tiếp từ chính bảng dự báo ngày.
    const upcomingDailyPeaks = daily
        .map(d => ({
            date: d.date,
            effectiveDate: d.date,
            time: d.peakTime,
            levelM: d.peakLevelM,
            at: new Date(`${d.date}T${d.peakTime}+07:00`)
        }))
        .filter(e => !Number.isNaN(e.at.getTime()) && e.at.getTime() >= nowMs - 15 * 60 * 1000)
        .sort((a, b) => a.at - b.at);

    const nextPeak = upcomingDailyPeaks[0] || null;
    const bulletinDateMs = new Date(`${String(bulletin.bulletin_date).slice(0, 10)}T09:00:00+07:00`).getTime();
    const ageHours = Number.isNaN(bulletinDateMs) ? null : Math.max(0, (nowMs - bulletinDateMs) / 3600000);

    const today = vietnamDateString();
    const forecastCoverageEnd = rows.length
        ? rows.map(r => String(r.forecast_date).slice(0, 10)).sort().at(-1)
        : null;

    // Không đánh dấu "cũ" chỉ vì bản tin được phát vài ngày trước nếu chính bản tin 5 ngày
    // vẫn còn bao phủ ngày hiện tại. Chỉ stale khi đã vượt khỏi cửa sổ dự báo.
    const stale = !forecastCoverageEnd || today > forecastCoverageEnd;

    const highest = daily.reduce((best, d) => !best || d.peakLevelM > best.peakLevelM ? d : best, null);
    const riskBand = riskBandForPeak(nextPeak?.levelM ?? highest?.peakLevelM ?? null);

    return {
        available: true,
        stale,
        bulletinAgeHours: ageHours == null ? null : Number(ageHours.toFixed(1)),
        staleHours: STALE_HOURS,
        forecastCoverageEnd,
        bulletinDate: String(bulletin.bulletin_date).slice(0, 10),
        fetchedAt: bulletin.fetched_at,
        sourceUrl: bulletin.source_url,
        sourceLabel: "Bản tin thủy triều TP.HCM - nguồn công bố chính thức",
        nextPeak: nextPeak ? {
            date: nextPeak.effectiveDate,
            sourceForecastDate: nextPeak.date,
            time: nextPeak.time,
            levelM: nextPeak.levelM,
            minutesFromNow: Math.round((nextPeak.at.getTime() - nowMs) / 60000)
        } : null,
        highestForecast: highest,
        riskBand,
        daily,
        message: stale
            ? `Cửa sổ dự báo của bản tin đã hết hạn (đến ${forecastCoverageEnd || "không xác định"}); chỉ hiển thị dữ liệu cũ để tham khảo.`
            : `Bản tin 5 ngày còn hiệu lực (dự báo đến ${forecastCoverageEnd}); dữ liệu này chỉ dùng để tham khảo.`,
        lastRefresh: lastRefreshResult
    };
}

function startTideScheduler() {
    if (!AUTO_FETCH || scheduler) return;

    const run = () => refreshTideData().catch(error => console.warn("[TIDE] Auto refresh failed:", error.message));
    setTimeout(run, 1500);
    scheduler = setInterval(run, Math.max(15, FETCH_INTERVAL_MINUTES) * 60 * 1000);
    console.log(`[TIDE] Auto fetch enabled, interval ${Math.max(15, FETCH_INTERVAL_MINUTES)} minutes.`);
}

module.exports = {
    refreshTideData,
    getHcmcTideSummary,
    getSiteTideSummary,
    startTideScheduler,
    parseForecastRows,
    parseBulletinDateFromText,
    riskBandForPeak,
    renderPageLayout,
    extractForecastDayRowsFromText,
    parseForecastRowsFromLayoutLines
};
