const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");
const XLSX = require("xlsx");
const fs = require("fs");

// ================= إعدادات الجروبات والملفات =================
const GROUPS = [
    {
        groupId: "120363405055654072@g.us",       // الجروب الأول (الحالي)
        excelPath: "./wardiaty.xlsx"              // ملف Excel الخاص به
    },
    {
        groupId: "120363423258920471@g.us", // ⚠️ ضع هنا معرف الجروب الثاني
        excelPath: "./wardiaty2.xlsx"             // ⚠️ اسم الملف الثاني الذي سترفعه
    }
    // يمكنك إضافة المزيد إذا أردت لاحقًا
];

// ================= إعدادات Gist لحفظ الحالة =================
const GIST_ID = "cd4bd1519749da63f37eaa594199e1df";
const STATUS_GIST_FILENAME = "bot_status33.json";
const part1 = "ghp_26iDRXBM6Vh9m";
const part2 = "egs7uCr6eEMi3It0T0UB3xJ";
const GITHUB_TOKEN = part1 + part2;
const GIST_API_URL = `https://api.github.com/gists/${GIST_ID}`;
const HEADERS = {
    "Authorization": `token ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Wardyati-Bot"
};

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function getRemoteLastSentDate() {
    try {
        const response = await fetch(GIST_API_URL, { headers: HEADERS });
        if (!response.ok) return null;
        const gist = await response.json();
        const file = gist.files[STATUS_GIST_FILENAME];
        if (!file || !file.content) return null;
        const data = JSON.parse(file.content);
        return data.lastSentDate;
    } catch (err) {
        console.error("خطأ في جلب الحالة من Gist:", err.message);
        return null;
    }
}

async function updateRemoteLastSentDate(dateStr) {
    try {
        const updatePayload = {
            files: {
                [STATUS_GIST_FILENAME]: {
                    content: JSON.stringify({ lastSentDate: dateStr })
                }
            }
        };
        await fetch(GIST_API_URL, {
            method: "PATCH",
            headers: HEADERS,
            body: JSON.stringify(updatePayload)
        });
        console.log("تم تحديث الحالة في Gist");
    } catch (err) {
        console.error("خطأ في تحديث الحالة في Gist:", err.message);
    }
}

// ================= جلب بيانات الورديات من ملف Excel (مع باراميتر للمسار) =================
async function fetchShiftsFromExcel(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            console.log(`لم يتم العثور على الملف: ${filePath}`);
            return null;
        }

        const workbook = XLSX.readFile(filePath);
        const tomorrow = format(addDays(new Date(), 1), "yyyy-MM-dd");
        
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        let startRowIndex = -1;
        let dateColumnIndex = -1;

        for (let R = 0; R < data.length; R++) {
            const row = data[R];
            if (!row || row.length === 0) continue;
            
            for (let C = 0; C < row.length; C++) {
                let cellValue = row[C];
                if (!cellValue) continue;

                let formattedCellValue = "";
                if (typeof cellValue === 'number') {
                    formattedCellValue = format(new Date(cellValue), "yyyy-MM-dd");
                } else {
                    formattedCellValue = String(cellValue).trim();
                }

                if (formattedCellValue.includes(tomorrow)) {
                    startRowIndex = R;
                    dateColumnIndex = C;
                    break;
                }
            }
            if (startRowIndex !== -1) break;
        }

        if (startRowIndex === -1) {
            console.log(`لم يتم العثور على تاريخ الغد (${tomorrow}) في الملف ${filePath}`);
            return null;
        }

        console.log(`تم العثور على تاريخ الغد في الملف ${filePath} - الصف ${startRowIndex + 1}`);

        let endRowIndex = data.length;
        for (let R = startRowIndex + 1; R < data.length; R++) {
            const row = data[R];
            if (row && row[dateColumnIndex]) {
                const val = String(row[dateColumnIndex]).trim();
                if (val.match(/^\d{4}-\d{2}-\d{2}$/) || val.includes("202")) {
                    endRowIndex = R;
                    break;
                }
            }
        }

        const headers = data[0] || [];
        const shiftsData = { shifts: {} };

        for (let C = 0; C < headers.length; C++) {
            if (C === dateColumnIndex) continue;
            
            const sectionName = String(headers[C] || `SECTION_${C}`).trim();
            if (sectionName === "undefined" || sectionName === "") continue;

            const persons = [];
            for (let R = startRowIndex; R < endRowIndex; R++) {
                const cellValue = data[R][C];
                if (cellValue && String(cellValue).trim().length > 1) {
                    const strVal = String(cellValue).trim();
                    if (strVal.includes("---") || strVal === "-") continue;

                    const phoneMatch = strVal.match(/\((.*?)\)/);
                    const name = strVal.replace(/\(.*?\)/, "").trim();
                    const phone = phoneMatch ? phoneMatch[1] : "";
                    
                    if (name) {
                        persons.push({ name, phone });
                    }
                }
            }

            if (persons.length > 0) {
                shiftsData.shifts[sectionName] = persons;
            }
        }

        if (Object.keys(shiftsData.shifts).length === 0) {
            console.log(`لا توجد بيانات ورديات في الملف ${filePath} ليوم الغد`);
            return null;
        }

        return { dateKey: tomorrow, shiftsData: shiftsData };

    } catch (err) {
        console.error(`فشل جلب البيانات من الملف ${filePath}:`, err.message);
        return null;
    }
}

function formatMessage(shiftsData, dateKey) {
    const dateObj = new Date(dateKey);
    const formattedDate = format(dateObj, "EEEE dd/MM/yyyy");

    const LTR = "\u200E";
    const RTL = "\u200F";

    let text = `${LTR}*_${formattedDate}_*\n`;
    text += `${LTR}══════════════════════════════\n\n`;

    const addPerson = (p) => {
        const name = p.name.trim();
        const phone = (p.phone && p.phone !== "غير معروف" && p.phone.trim() !== "")
            ? p.phone.trim()
            : null;

        text += `${LTR}▪️ ${LTR}${name}\n`;
        if (phone) {
            text += `${RTL}(${phone})\n`;
        } else {
            text += `\n`;
        }
    };

    const addSection = (type) => {
        if (!shiftsData.shifts[type] || shiftsData.shifts[type].length === 0) return false;

        const validPersons = shiftsData.shifts[type].filter(p => {
            const name = p.name.trim();
            return name.length > 0 && !name.includes("---") && name !== "-";
        });

        if (validPersons.length === 0) return false;

        text += `${LTR}*${type}*\n\n`;

        for (const p of validPersons) {
            addPerson(p);
        }
        text += `\n`;
        return true;
    };

    const dayPriority = [
        "ER ADMISSIONS -DAY-🚨☀️",
        "ER GENERAL-DAY-🚨☀️",
        "ER PT-DAY-🚨☀️",
        "ER TRIAGE-DAY-🚨☀️",
        "ER WARD-DAY-🚨☀️"
    ];

    const nightPriority = [
        "ER ADMISSION-NIGHT-🚨🌙",
        "ER PT-NIGHT-🚨🌙",
        "ER GENERAL-NIGHT-🚨🌙",
        "ER WARD-NIGHT-🚨🌙",
        "ER TRIAGE-NIGHT-🚨🌙"
    ];

    let hasDay = false;
    let hasNight = false;

    for (const type of dayPriority) {
        if (shiftsData.shifts[type]) {
            if (addSection(type)) hasDay = true;
        }
    }
    for (const type in shiftsData.shifts) {
        if (type.toUpperCase().includes("DAY") && !dayPriority.includes(type)) {
            if (addSection(type)) hasDay = true;
        }
    }
    if (hasDay) text += `\n`;

    for (const type of nightPriority) {
        if (shiftsData.shifts[type]) {
            if (addSection(type)) hasNight = true;
        }
    }
    for (const type in shiftsData.shifts) {
        if (type.toUpperCase().includes("NIGHT") && !nightPriority.includes(type)) {
            if (addSection(type)) hasNight = true;
        }
    }

    for (const type in shiftsData.shifts) {
        const upper = type.toUpperCase();
        if (!upper.includes("DAY") && !upper.includes("NIGHT")) {
            addSection(type);
        }
    }

    return text.trim();
}

// ================= الجدولة اليومية (موحدة لكل الجروبات) =================
let lastSentDate = null;

async function runScheduler(sock) {
    try {
        const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
        const hour = nowEgypt.getHours();
        const todayStr = format(nowEgypt, "yyyy-MM-dd");

        console.log(`[فحص الجدولة] الساعة: ${hour}:${nowEgypt.getMinutes()}, اليوم: ${todayStr}, آخر إرسال: ${lastSentDate}`);

        // الإرسال ابتداءً من الساعة 12 ظهراً إذا لم يُرسل اليوم بعد
        if (hour >= 12 && lastSentDate !== todayStr) {
            let sentAnything = false;

            for (const group of GROUPS) {
                console.log(`جاري معالجة الجروب: ${group.groupId} - الملف: ${group.excelPath}`);
                const result = await fetchShiftsFromExcel(group.excelPath);

                if (result) {
                    const message = formatMessage(result.shiftsData, result.dateKey);
                    await sock.sendMessage(group.groupId, { text: message });
                    console.log(`تم إرسال ورديات الغد إلى الجروب ${group.groupId}`);
                    sentAnything = true;
                } else {
                    console.log(`لا توجد بيانات جديدة للجروب ${group.groupId}`);
                }
            }

            if (sentAnything) {
                lastSentDate = todayStr;
                await updateRemoteLastSentDate(todayStr);
            }
        }
    } catch (err) {
        console.error("خطأ في الجدولة:", err.message);
    }
}

// ================= الاتصال بواتساب =================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Wardyati Bot", "Chrome", "121.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    // ================= أمر id لمعرفة ID الجروب =================
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation ||
                      msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

        if (from.endsWith("@g.us") && text === "id" && !msg.key.fromMe) {
               console.log(from);
           // await sock.sendMessage(from, {
              //  text: `معرف هذا الجروب هو:\n\n\`${from}\``
          //  }, { quoted: msg });
        }
    });

    // ================= تحديثات الاتصال =================
    sock.ev.on("connection.update", async (update) => {
        const { connection, qr } = update;

        if (qr) {
            console.clear();
            console.log("امسح الـ QR الجديد:");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    global.qrImage = url;
                    console.log("http://localhost:5000");
                }
            });
        }

        if (connection === "open") {
            console.log("تم الاتصال بواتساب بنجاح!");

            // جلب آخر تاريخ إرسال من Gist
            lastSentDate = await getRemoteLastSentDate();
            console.log(`آخر تاريخ إرسال: ${lastSentDate || "لا يوجد"}`);

            // تشغيل الجدولة فورًا ثم كل 10 دقائق
            runScheduler(sock);
            setInterval(() => runScheduler(sock), 30 * 60 * 1000);
        }

        if (connection === "close") {
            const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("جاري إعادة الاتصال...");
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log("تم تسجيل الخروج يدويًا – لن يتم إعادة الاتصال.");
            }
        }
    });
}

// ================= سيرفر عرض الـ QR =================
require("express")()
    .get("/", (req, res) => {
        res.send(global.qrImage
            ? `<center><h1 style="color:green">امسح الـ QR</h1><img src="${global.qrImage}" width="400"></center>`
            : `<h1>جاري توليد الـ QR... <script>setTimeout(() => location.reload(), 3000);</script></h1>`
        );
    })
    .listen(5000, () => console.log("افتح المتصفح: http://localhost:5000"));

connectToWhatsApp();
