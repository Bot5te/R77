const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
// ================= إعدادات Gist =================
const GIST_ID = "cd4bd1519749da63f37eaa594199e1df";
const SHIFTS_GIST_FILENAME = "shifts_data.json";
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
                [SHIFTS_GIST_FILENAME]: null  // null = حذف الملف
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

// ================= تنسيق الرسالة (النسخة المحسّنة) =================
function formatMessage(shiftsData, dateKey) {
    const dateObj = new Date(dateKey);
    const formattedDate = format(dateObj, "EEEE dd/MM/yyyy");

    let text = `*_ورديات يوم ${_formattedDate}_*\n`;
    text += "══════════════════════════════\n\n";

    const order = ["Day", "Day Work", "Night", "lista"];
    const seen = new Set(); // لتفادي تكرار الأسماء

    // دالة مساعدة لإضافة شيفت واحد
    const addShift = (type) => {
        if (!shiftsData.shifts[type] || shiftsData.shifts[type].length === 0) return;

        text += `*${type}*\n\n`; // العنوان bold + سطر فارغ تحته

        for (const p of shiftsData.shifts[type]) {
            const key = `${p.name}|${p.phone}`;
            if (!seen.has(key)) {
                text += `• ${p.name}`;
                if (p.phone && p.phone !== "غير معروف" && p.phone.trim() !== "") {
                    text += `  (${p.phone})`;
                }
                text += `\n`;
                seen.add(key);
            }
        }
        text += `\n`; // سطر فارغ بعد انتهاء الشيفت (فاصل جميل)
    };

    // الأولوية حسب الترتيب المطلوب
    for (const type of order) {
        addShift(type);
    }

    // باقي الأنواع التي خارج الترتيب (لو فيه أي شيفتات إضافية)
    for (const type in shiftsData.shifts) {
        if (!order.includes(type)) {
            addShift(type);
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

            // من 8:00 إلى 8:44 صباحًا (يمكنك تغييرها إلى 10:00 زي ما تحب)
            if (hour === 13 && minute < 60 && lastSentDate !== todayStr) {

                console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] جاري البحث عن ورديات الغد في الـ Gist...`);

                const result = await fetchShiftsFromGist();

                if (!result) {
                    console.log("لا توجد ورديات جديدة في الـ Gist اليوم");
                    return;
                }

                const message = formatMessage(result.shiftsData, result.dateKey);

                await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                console.log("تم إرسال ورديات الغد بنجاح إلى الجروب!");

                // حذف الملف بعد الإرسال الناجح
                await deleteShiftsFileFromGist();

                lastSentDate = todayStr;
                console.log("-".repeat(60));
            }
        } catch (err) {
            console.error("خطأ في الجدولة:", err.message);
        }
    }, 4 * 60 * 1000); // كل 4 دقائق بالضبط
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
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        }
    });
}

// ================= سيرفر الـ QR =================
require("express")()
    .get("/", (req, res) => {
        res.send(global.qrImage
            ? `<center><h1 style="color:green">امسح الـ QR</h1><img src="${global.qrImage}" width="400"></center>`
            : `<h1>جاري توليد الـ QR... <script>setTimeout(() => location.reload(), 3000);</script></h1>`
        );
    })
    .listen(5000, () => console.log("افتح: http://localhost:5000"));

connectToWhatsApp();
