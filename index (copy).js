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
const ROOM_TEXT = "شيفتات جراحة غدد شهر 12"; // غيّر الشهر كل شهر (مثل: شهر 1، شهر 2...)
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
            if (hour === 10 && minute < 55 && lastSentDate !== todayStr) {
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

// ================= جلب ورديات الغد (باستخدام cloudscraper = يتجاوز Cloudflare) =================
async function fetchTomorrowShifts() {
    const tomorrow = addDays(new Date(), 1);
    const targetDate = format(tomorrow, "yyyy-MM-dd");
    const year = tomorrow.getFullYear();
    const month = tomorrow.getMonth() + 1;

    try {
        // 1. جلب صفحة اللوجن + CSRF
        const loginPage = await cloudscraper.get("https://wardyati.com/login/", { resolveWithFullResponse: true });
        const $ = cheerio.load(loginPage.body);
        const csrfToken = $('input[name="csrfmiddlewaretoken"]').val() || "";

        // 2. تسجيل الدخول
        await cloudscraper.post("https://wardyati.com/login/", {
            form: {
                username: LOGIN_EMAIL,
                password: LOGIN_PASSWORD,
                csrfmiddlewaretoken: csrfToken,
            },
            headers: { Referer: "https://wardyati.com/login/" },
            followAllRedirects: true,
        });

        // 3. جلب صفحة الغرف
        const homePage = await cloudscraper.get("https://wardyati.com/rooms/");
        const $$ = cheerio.load(homePage);
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

        if (!roomUrl) {
            console.log("لم يتم العثور على الغرفة! تأكد من النص:", ROOM_TEXT);
            return null;
        }

        // 4. جلب بيانات الشهر
        const arenaUrl = roomUrl + "arena/";
        const arenaResponse = await cloudscraper.get(arenaUrl, {
            qs: { view: "monthly", year, month },
        });

        const data = JSON.parse(arenaResponse);

        if (!data.shift_instances_by_date?.[targetDate]) {
            return {
                date: format(tomorrow, "EEEE dd/MM"),
                message: "لا توجد ورديات الغد (إجازة أو لم تُحدد بعد)"
            };
        }

        const shifts = {};

        for (const shift of data.shift_instances_by_date[targetDate]) {
            const type = shift.shift_type_name || "Unknown";
            const detailsUrl = "https://wardyati.com" + shift.get_shift_instance_details_url;

            try {
                const detailsHtml = await cloudscraper.get(detailsUrl, {
                    headers: { "HX-Request": "true" }
                });
                const details = JSON.parse(detailsHtml);

                for (const h of details.holdings || []) {
                    const name = h.apparent_name || "غير معروف";
                    let phone = "";

                    if (h.urls?.get_member_info) {
                        try {
                            const memHtml = await cloudscraper.get("https://wardyati.com" + h.urls.get_member_info, {
                                headers: { "HX-Request": "true" }
                            });
                            const memData = JSON.parse(memHtml);
                            phone = memData.room_member?.contact_info || "";
                        } catch (e) { /* تجاهل */ }
                    }

                    shifts[type] = shifts[type] || [];
                    shifts[type].push({ name, phone });
                }
            } catch (e) {
                continue;
            }
        }

        return { date: format(tomorrow, "EEEE dd/MM"), shifts };
    } catch (err) {
        console.error("فشل جلب الورديات:", err.message);
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