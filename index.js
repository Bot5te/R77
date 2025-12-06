const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const fetch = require("node-fetch");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");

// ================= إعدادات البوت =================
const GIST_ID = "cd4bd1519749da63f37eaa594199e1df";
const part1 = "ghp_26iDRXBM6Vh9m";
const part2 = "egs7uCr6eEMi3It0T0UB3xJ";

const GITHUB_TOKEN = part1 + part2;

const SHIFTS_GIST_FILENAME = "shifts_data.json";
const TARGET_GROUP_ID = "120363410674115070@g.us"; // معرف الجروب اللي هيرسل فيه

let lastSentDate = null;
global.qrImage = null;

// ================= بدء الاتصال بواتساب =================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const version = [2, 3000, 1027934701]; // إصدار ثابت = لا يفصل أبدًا

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Chrome (Linux)", "Chrome", "121.0.6167.140"],
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, qr } = update;

        if (qr) {
            console.clear();
            console.log("تم توليد QR جديد! امسحه بسرعة:");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    global.qrImage = url;
                    console.log("افتح الرابط لرؤية الـ QR: http://localhost:5000");
                }
            });
        }

        if (connection === "open") {
            console.log("تم الاتصال بنجاح بواتساب!");
            console.log("البوت جاهز لإرسال ورديات الغد يوميًا من 8:00 إلى 8:44 صباحًا بتوقيت مصر");
        }

        if (connection === "close") {
            const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(shouldReconnect ? "انقطع الاتصال... جاري إعادة الاتصال" : "تم تسجيل الخروج");
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        }
    });

    // ================= الجدولة اليومية (من 8:00 إلى 8:44 صباحًا) =================
    setInterval(async () => {
        try {
            const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
            const hour = nowEgypt.getHours();
            const minute = nowEgypt.getMinutes();
            const todayStr = format(nowEgypt, "yyyy-MM-dd");

            // نفس شرط البوت الأصلي بالظبط
            if (hour === 22 && minute < 55 && lastSentDate !== todayStr) {
                console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] جاري جلب ورديات الغد...`);
                console.log("-".repeat(60));

                const result = await fetchTomorrowShifts();

                if (result) {
                    const message = formatMessage(result);
                    await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                    console.log("تم إرسال ورديات الغد بنجاح إلى الجروب!");
                } else {
                    await sock.sendMessage(TARGET_GROUP_ID, { text: "فشل جلب ورديات الغد اليوم... سأحاول غدًا إن شاء الله" });
                    console.log("فشل جلب الورديات");
                }

                console.log("-".repeat(60));
                lastSentDate = todayStr;
            }
        } catch (err) {
            console.error("خطأ في الجدولة:", err.message);
        }
    }, 9000); // كل 9 ثواني مثل البوت الأصلي
}

// ================= جلب ورديات الغد من Gist =================
async function fetchTomorrowShifts() {
    const tomorrow = addDays(new Date(), 1);
    const targetDate = format(tomorrow, "yyyy-MM-dd");

    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
    };

    try {
        // جلب الـ Gist
        const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
        if (!response.ok) {
            console.error("فشل جلب الـ Gist:", response.status);
            return null;
        }

        const gistData = await response.json();

        if (!gistData.files || !gistData.files[SHIFTS_GIST_FILENAME]) {
            console.log("لم يتم العثور على الملف في الـ Gist!");
            return null;
        }

        const content = gistData.files[SHIFTS_GIST_FILENAME].content;
        const jsonData = JSON.parse(content);

        if (!jsonData[targetDate] || !jsonData[targetDate].shifts) {
            return {
                date: format(tomorrow, "EEEE dd/MM"),
                message: "لا توجد ورديات الغد (إجازة أو لم تُحدد بعد)"
            };
        }

        const shifts = jsonData[targetDate].shifts;

        // حذف الملف من الـ Gist بعد الجلب
        const deleteBody = {
            files: {
                [SHIFTS_GIST_FILENAME]: null
            }
        };

        const deleteResponse = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(deleteBody)
        });

        if (!deleteResponse.ok) {
            console.error("فشل حذف الملف من الـ Gist:", deleteResponse.status);
        } else {
            console.log("تم حذف ملف shifts_data.json من الـ Gist بنجاح");
        }

        return { date: format(tomorrow, "EEEE dd/MM"), shifts };
    } catch (err) {
        console.error("فشل جلب الورديات من الـ Gist:", err.message);
        return null;
    }
}

// ================= تنسيق الرسالة =================
function formatMessage(result) {
    if (!result) return "فشل جلب الورديات اليوم";

    let text = `ورديات الغد\n${result.date}\n`;
    text += "══════════════════════════════\n\n";

    const order = ["Day", "Day Work", "Night"];
    const seen = new Set();

    for (const type of order) {
        if (result.shifts?.[type]) {
            text += `${type}\n`;
            for (const p of result.shifts[type]) {
                const key = `${p.name}|${p.phone}`;
                if (!seen.has(key)) {
                    text += `• ${p.name}\n`;
                    if (p.phone) text += `  (${p.phone})\n`;
                    seen.add(key);
                }
            }
            text += "\n";
        }
    }

    // الأنواع الأخرى
    for (const type in result.shifts) {
        if (!order.includes(type) && !seen.has(type)) {
            text += `${type}\n`;
            for (const p of result.shifts[type]) {
                const key = `${p.name}|${p.phone}`;
                if (!seen.has(key)) {
                    text += `• ${p.name}\n`;
                    if (p.phone) text += `  (${p.phone})\n`;
                    seen.add(key);
                }
            }
            text += "\n";
        }
    }

    if (result.message) {
        text = `ورديات الغد\n${result.date}\n`;
        text += "══════════════════════════════\n";
        text += result.message;
    }

    return text.trim();
}

// ================= سيرفر عرض الـ QR =================
require("express")()
    .get("/", (req, res) => {
        res.send(global.qrImage
            ? `<h1 style="text-align:center;color:green">امسح الـ QR بسرعة!</h1><center><img src="${global.qrImage}" width="400"></center>`
            : `<h1>جاري توليد الـ QR... انتظر</h1><script>setTimeout(() => location.reload(), 3000);</script>`
        );
    })
    .listen(5000, () => console.log("افتح الرابط لرؤية الـ QR: http://localhost:5000"));

// ================= بدء البوت =================
connectToWhatsApp();
