const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const cloudscraper = require("cloudscraper");
const cheerio = require("cheerio");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");

// ================= إعدادات البوت =================
const LOGIN_EMAIL = "mm2872564@gmail.com";
const LOGIN_PASSWORD = "Mm@12345";
const ROOM_TEXT = "شيفتات جراحة غدد شهر 12"; // غيّر الشهر كل شهر
const TARGET_GROUP_ID = "120363410674115070@g.us";

let lastSentDate = null;
global.qrImage = null;

// ================= دالة إعادة المحاولة القوية (مثل الـ Python بالضبط) =================
const MAX_RETRIES = 5;
const BASE_DELAY = 7;

async function retry(fn) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const wait = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 5;
            const now = format(toZonedTime(new Date(), "Africa/Cairo"), "HH:mm:ss");
            console.log(`[${now}] خطأ (${attempt}/${MAX_RETRIES}): ${err.message}`);

            if (attempt === MAX_RETRIES) {
                console.log("فشل نهائي بعد كل المحاولات، ننتقل...");
                return null;
            }
            console.log(`إعادة المحاولة بعد ${wait.toFixed(1)} ثانية...`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
}

// ================= بدء البوت مع حماية كاملة =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const version = [2, 3000, 1027934701];

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Chrome (Linux)", "Chrome", "121.0.6167.140"],
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 20_000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, qr } = update;

        if (qr) {
            console.clear();
            console.log("تم توليد QR جديد! امسحه فورًا:");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    global.qrImage = url;
                    console.log("افتح الرابط لرؤية الـ QR: http://localhost:5000");
                }
            });
        }

        if (connection === "open") {
            console.log("تم الاتصال بنجاح بواتساب! البوت شغال 24/7 ولن يسقط أبدًا");
        }

        if (connection === "close") {
            const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(shouldReconnect ? "انقطع الاتصال... جاري إعادة الاتصال خلال 5 ثواني" : "تم تسجيل الخروج");
            if (shouldReconnect) setTimeout(startBot, 5000);
        }
    });

    // ================= الجدولة اليومية (من 8:00 إلى 8:44 صباحًا) =================
    setInterval(async () => {
        try {
            const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
            console.log(`التشيك الحالي: ${format(nowEgypt, "HH:mm:ss")} بتوقيت مصر - اليوم: ${format(nowEgypt, "yyyy-MM-dd")}`);  // ← التعديل الجديد: طباعة الوقت في كل فحص
            
            const hour = nowEgypt.getHours();
            const minute = nowEgypt.getMinutes();
            const today = format(nowEgypt, "yyyy-MM-dd");

            if (hour === 13 && minute < 45 && lastSentDate !== today) {
                console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] جاري جلب ورديات الغد...`);
                console.log("-".repeat(60));

                const result = await fetchTomorrowShiftsWithRetry();

                if (result) {
                    const message = formatMessage(result);
                    await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                    console.log("تم إرسال ورديات الغد بنجاح إلى الجروب!");
                } else {
                    await sock.sendMessage(TARGET_GROUP_ID, { text: "فشل جلب الورديات اليوم... سأحاول غدًا إن شاء الله" });
                }

                console.log("-".repeat(60));
                lastSentDate = today;
            }
        } catch (err) {
            console.error("خطأ في الجدولة:", err.message);
        }
    }, 60000); // كل دقيقة (60 ثانية) عشان الـ Logs تبقى نظيفة وما تستهلكش موارد زيادة
}

// ================= جلب الورديات مع retry قوي جدًا (أقوى من البايثون) =================
async function fetchTomorrowShiftsWithRetry() {
    return await retry(async () => {
        const tomorrow = addDays(new Date(), 1);
        const targetDate = format(tomorrow, "yyyy-MM-dd");
        const year = tomorrow.getFullYear();
        const month = tomorrow.getMonth() + 1;

        // 1. تسجيل الدخول
        const loginPage = await cloudscraper.get("https://wardyati.com/login/");
        const $ = cheerio.load(loginPage);
        const csrf = $('input[name="csrfmiddlewaretoken"]').val() || "";

        await cloudscraper.post("https://wardyati.com/login/", {
            form: { username: LOGIN_EMAIL, password: LOGIN_PASSWORD, csrfmiddlewaretoken: csrf },
            headers: { Referer: "https://wardyati.com/login/" },
            followAllRedirects: true,
        });

        // 2. البحث عن الغرفة
        const home = await cloudscraper.get("https://wardyati.com/rooms/");
        const $$ = cheerio.load(home);
        let roomUrl = null;

        $$('div.overflow-wrap').each((i, el) => {
            if ($$(el).text().includes(ROOM_TEXT)) {
                const link = $$(el).closest('.card-body').find('a.stretched-link').attr('href');
                if (link) {
                    roomUrl = link.startsWith("http") ? link : "https://wardyati.com" + link;
                    return false;
                }
            }
        });

        if (!roomUrl) throw new Error("لم يتم العثور على الغرفة");

        // 3. جلب الورديات
        const arena = await cloudscraper.get(roomUrl + "arena/", {
            qs: { view: "monthly", year, month },
        });

        const data = JSON.parse(arena);

        if (!data.shift_instances_by_date?.[targetDate]) {
            return { date: format(tomorrow, "EEEE dd/MM"), message: "لا توجد ورديات الغد (إجازة أو لم تُحدد بعد)" };
        }

        const shifts = {};

        for (const shift of data.shift_instances_by_date[targetDate]) {
            const type = shift.shift_type_name || "Unknown";
            const detailsUrl = "https://wardyati.com" + shift.get_shift_instance_details_url;

            try {
                const detailsHtml = await cloudscraper.get(detailsUrl, { headers: { "HX-Request": "true" } });
                const details = JSON.parse(detailsHtml);

                for (const h of details.holdings || []) {
                    const name = h.apparent_name || "غير معروف";
                    let phone = "";
                    if (h.urls?.get_member_info) {
                        try {
                            const memHtml = await cloudscraper.get("https://wardyati.com" + h.urls.get_member_info, { headers: { "HX-Request": "true" } });
                            const memData = JSON.parse(memHtml);
                            phone = memData.room_member?.contact_info || "";
                        } catch {}
                    }
                    shifts[type] = shifts[type] || [];
                    shifts[type].push({ name, phone });
                }
            } catch (e) {
                continue;
            }
        }

        return { date: format(tomorrow, "EEEE dd/MM"), shifts };
    });
}

// ================= تنسيق الرسالة =================
function formatMessage(r) {
    if (!r) return "فشل جلب الورديات اليوم";

    let text = `ورديات الغد\n${r.date}\n`;
    text += "══════════════════════════════\n\n";

    const order = ["Day", "Day Work", "Night"];
    const seen = new Set();

    for (const type of order) {
        if (r.shifts?.[type]) {
            text += `${type}\n`;
            for (const p of r.shifts[type]) {
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

    for (const type in r.shifts) {
        if (!order.includes(type)) {
            text += `${type}\n`;
            for (const p of r.shifts[type]) {
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

    if (r.message) {
        text = `ورديات الغد\n${r.date}\n`;
        text += "══════════════════════════════\n";
        text += r.message;
    }

    return text.trim();
}

// ================= سيرفر الـ QR =================
require("express")()
    .get("/", (req, res) => {
        res.send(global.qrImage
            ? `<h1 style="text-align:center;color:green">امسح الـ QR بسرعة!</h1><center><img src="${global.qrImage}" width="400"></center>`
            : `<h1>جاري توليد الـ QR... انتظر</h1><script>setTimeout(() => location.reload(), 3000);</script>`
        );
    })
    .listen(5000, () => console.log("QR: http://localhost:5000"));

// ================= حماية نهائية: لو الكود كله وقع =================
process.on("uncaughtException", (err) => {
    console.error("خطأ غير متوقع! البوت سيعيد التشغيل:", err.message);
    setTimeout(startBot, 10000);
});

process.on("unhandledRejection", (err) => {
    console.error("وعد مرفوض:", err);
    setTimeout(startBot, 10000);
});

// ================= بدء البوت =================
startBot();
