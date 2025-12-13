const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ================= إعدادات Gist =================
const GIST_ID = "cd4bd1519749da63f37eaa594199e1df";
const SHIFTS_GIST_FILENAME = "shifts_datatry.json";
const part1 = "ghp_26iDRXBM6Vh9m";
const part2 = "egs7uCr6eEMi3It0T0UB3xJ";
const GITHUB_TOKEN = part1 + part2;

const GIST_API_URL = `https://api.github.com/gists/${GIST_ID}`;
const HEADERS = {
    "Authorization": `token ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Wardyati-Bot"
};

// ================= إعدادات البوت =================
const TARGET_GROUP_ID = "120363410674115070@g.us";
let lastSentDate = null;
global.qrImage = null;

// ================= جلب بيانات الورديات من Gist =================
async function fetchShiftsFromGist() {
    try {
        const response = await fetch(GIST_API_URL, { headers: HEADERS });
        if (!response.ok) throw new Error(`Gist HTTP ${response.status}`);

        const gist = await response.json();
        const file = gist.files[SHIFTS_GIST_FILENAME];

        if (!file || !file.content) {
            console.log("لم يتم العثور على ملف shifts_data.json في الـ Gist");
            return null;
        }

        const data = JSON.parse(file.content);
        const tomorrow = format(addDays(new Date(), 1), "yyyy-MM-dd");

        if (!data[tomorrow]) {
            console.log(`لا توجد ورديات ليوم الغد (${tomorrow}) في الـ Gist`);
            return null;
        }

        console.log(`تم العثور على ورديات الغد (${tomorrow}) في الـ Gist`);
        return { dateKey: tomorrow, shiftsData: data[tomorrow] };

    } catch (err) {
        console.error("فشل جلب البيانات من Gist:", err.message);
        return null;
    }
}

// ================= حذف الملف من Gist بعد الإرسال الناجح =================
async function deleteShiftsFileFromGist() {
    try {
        const updatePayload = {
            description: "حذف ورديات الغد بعد الإرسال",
            files: {
                [SHIFTS_GIST_FILENAME]: null
            }
        };

        const response = await fetch(GIST_API_URL, {
            method: "PATCH",
            headers: HEADERS,
            body: JSON.stringify(updatePayload)
        });

        if (response.ok) {
            console.log("تم حذف ملف shifts_data.json من الـ Gist بنجاح");
        } else {
            console.error("فشل حذف الملف من Gist:", await response.text());
        }
    } catch (err) {
        console.error("خطأ أثناء حذف الملف:", err.message);
    }
}


function formatMessage(shiftsData, dateKey) {
    const dateObj = new Date(dateKey);
    const formattedDate = format(dateObj, "EEEE dd/MM/yyyy");

    const LTR = "\u200E";
    const RTL = "\u200F";

    let text = `${LTR}*_${formattedDate}_*\n`;
    text += `${LTR}══════════════════════════════\n\n`;

    const seen = new Set();

    const addPerson = (p) => {
        const key = `${p.name}|${p.phone}`;
        if (seen.has(key)) return;
        seen.add(key);

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

        text += `${LTR}*${type}*\n\n`;

        for (const p of shiftsData.shifts[type]) {
            addPerson(p);
        }
        text += `\n`;
        return true;
    };

    // === قوائم الأولوية المطابقة للـ JSON بالضبط ===
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

    // Day: الأولوية أولاً
    for (const type of dayPriority) {
        if (shiftsData.shifts[type]) {
            if (addSection(type)) hasDay = true;
        }
    }
    // باقي Day غير المدرجة في الأولوية
    for (const type in shiftsData.shifts) {
        if (type.toUpperCase().includes("DAY") && !dayPriority.includes(type)) {
            if (addSection(type)) hasDay = true;
        }
    }
    if (hasDay) text += `\n`;

    // Night: الأولوية أولاً
    for (const type of nightPriority) {
        if (shiftsData.shifts[type]) {
            if (addSection(type)) hasNight = true;
        }
    }
    // باقي Night
    for (const type in shiftsData.shifts) {
        if (type.toUpperCase().includes("NIGHT") && !nightPriority.includes(type)) {
            if (addSection(type)) hasNight = true;
        }
    }

    // أقسام أخرى
    for (const type in shiftsData.shifts) {
        const upper = type.toUpperCase();
        if (!upper.includes("DAY") && !upper.includes("NIGHT")) {
            addSection(type);
        }
    }

    return text.trim();
}

// ================= الجدولة اليومية =================
async function startScheduler(sock) {
    setInterval(async () => {
        try {
            const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
            const hour = nowEgypt.getHours();
            const minute = nowEgypt.getMinutes();
            const todayStr = format(nowEgypt, "yyyy-MM-dd");

            // الساعة 14:00 (2 ظهرًا) – يمكنك تغييرها لأي وقت تحبه
            if (hour === 18 && minute < 60 && lastSentDate !== todayStr) {

                console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] جاري البحث عن ورديات الغد...`);

                const result = await fetchShiftsFromGist();

                if (!result) {
                    console.log("لا توجد ورديات جديدة اليوم");
                    return;
                }

                const message = formatMessage(result.shiftsData, result.dateKey);

                await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                console.log("تم إرسال ورديات الغد بنجاح!");

                await deleteShiftsFileFromGist();

                lastSentDate = todayStr;
                console.log("-".repeat(60));
            }
        } catch (err) {
            console.error("خطأ في الجدولة:", err.message);
        }
    }, 4 * 60 * 1000); // كل 4 دقائق
}

// ================= الاتصال بواتساب + الأمر id =================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Wardyati Bot", "Chrome", "121.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    // ================= معالجة الرسائل (أمر id) =================
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation ||
                      msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

        // أمر "id" لإظهار معرف الجروب
        if (from.endsWith("@g.us") && text === "id") {
            if (msg.key.fromMe) return; // تجاهل رسائل البوت نفسه
            /*
            await sock.sendMessage(from, {
                text: `معرف هذا الجروب هو:\n\n\`${from}\``
            }, { quoted: msg });
            */

        
            console.log(`تم إرسال ID الجروب المطلوب: ${from}`);
        }
    });

    // ================= تحديثات الاتصال وقراءة QR =================
    sock.ev.on("connection.update", (update) => {
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
            startScheduler(sock); // بدء الجدولة بعد الاتصال
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
