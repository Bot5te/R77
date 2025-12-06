const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const puppeteer = require("puppeteer");
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
let browser = null; // لإعادة استخدام المتصفح
let isConnected = false; // حالة الاتصال بواتساب

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
            isConnected = true;
        }

        if (connection === "close") {
            const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(shouldReconnect ? "انقطع الاتصال... جاري إعادة الاتصال" : "تم تسجيل الخروج");
            isConnected = false;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        }
    });

    return sock;
}

// ================= إنشاء جلسة Puppeteer =================
async function createPuppeteerSession() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'],
            timeout: 60000,
        });
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setJavaScriptEnabled(true);
    return page;
}

// ================= جلب ورديات الغد (باستخدام Puppeteer = يتجاوز Cloudflare) =================
async function fetchTomorrowShifts() {
    const tomorrow = addDays(new Date(), 1);
    const targetDate = format(tomorrow, "yyyy-MM-dd");
    const year = tomorrow.getFullYear();
    const month = tomorrow.getMonth() + 1;

    let page;
    try {
        page = await createPuppeteerSession();

        // 1. الذهاب إلى صفحة اللوجن
        await page.goto("https://wardyati.com/login/", { waitUntil: 'networkidle2', timeout: 30000 });
        await randomDelay(2, 4);

        // 2. استخراج CSRF وتسجيل الدخول
        const csrfToken = await page.evaluate(() => {
            const input = document.querySelector('input[name="csrfmiddlewaretoken"]');
            return input ? input.value : '';
        });

        if (!csrfToken) {
            console.error("لم يتم العثور على CSRF token");
            return null;
        }

        await page.type('input[name="username"]', LOGIN_EMAIL);
        await page.type('input[name="password"]', LOGIN_PASSWORD);
        await page.evaluate((token) => {
            document.querySelector('input[name="csrfmiddlewaretoken"]').value = token;
        }, csrfToken);

        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        await randomDelay(1, 3);

        // تحقق من تسجيل الدخول
        if (page.url().includes('/login/')) {
            console.error("فشل تسجيل الدخول");
            return null;
        }

        // 3. الذهاب إلى صفحة الغرف
        await page.goto("https://wardyati.com/rooms/", { waitUntil: 'networkidle2' });
        await randomDelay(1, 2);

        const roomUrl = await page.evaluate((text) => {
            const divs = document.querySelectorAll('div.overflow-wrap');
            for (let div of divs) {
                if (div.textContent.includes(text)) {
                    const link = div.closest('.card-body').querySelector('a.stretched-link');
                    return link ? link.href : null;
                }
            }
            return null;
        }, ROOM_TEXT);

        if (!roomUrl) {
            console.log("لم يتم العثور على الغرفة! تأكد من النص:", ROOM_TEXT);
            return null;
        }

        // 4. جلب بيانات الشهر (استخدم fetch داخل Puppeteer للـ API)
        const arenaUrl = `${roomUrl}arena/?view=monthly&year=${year}&month=${month}`;
        const arenaResponse = await page.evaluate(async (url) => {
            const resp = await fetch(url, { method: 'GET' });
            return await resp.json();
        }, arenaUrl);

        if (!arenaResponse.shift_instances_by_date?.[targetDate]) {
            return {
                date: format(tomorrow, "EEEE dd/MM"),
                message: "لا توجد ورديات الغد (إجازة أو لم تُحدد بعد)"
            };
        }

        const shifts = {};

        for (const shift of arenaResponse.shift_instances_by_date[targetDate]) {
            const type = shift.shift_type_name || "Unknown";
            const detailsUrl = "https://wardyati.com" + shift.get_shift_instance_details_url;

            try {
                const details = await page.evaluate(async (url) => {
                    const resp = await fetch(url, { headers: { 'HX-Request': 'true' } });
                    return await resp.json();
                }, detailsUrl);

                for (const h of details.holdings || []) {
                    const name = h.apparent_name || "غير معروف";
                    let phone = "";

                    if (h.urls?.get_member_info) {
                        try {
                            const memData = await page.evaluate(async (url) => {
                                const resp = await fetch(url, { headers: { 'HX-Request': 'true' } });
                                return await resp.json();
                            }, "https://wardyati.com" + h.urls.get_member_info);
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
    } finally {
        if (page) await page.close();
    }
}

// ================= دالة تأخير عشوائي =================
function randomDelay(min, max) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) * 1000 + min * 1000));
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
let sock;
(async () => {
    sock = await connectToWhatsApp();

    // ================= الجدولة اليومية (من 8:00 إلى 8:44 صباحًا) =================
    setInterval(async () => {
        try {
            const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
            const hour = nowEgypt.getHours();
            const minute = nowEgypt.getMinutes();
            const todayStr = format(nowEgypt, "yyyy-MM-dd");

            // نفس شرط البوت الأصلي بالظبط
            if (hour === 16 && minute < 55 && lastSentDate !== todayStr) {
                if (!isConnected) {
                    console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] البوت غير متصل بواتساب... انتظر الاتصال`);
                    return;
                }

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
})();

// إغلاق المتصفح عند إنهاء البرنامج
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});
