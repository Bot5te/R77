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
let isConnected = false; // حالة الاتصال بواتساب

// ================= قائمة User-Agents حقيقية =================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

// ================= إنشاء headers مشابهة للمتصفح =================
function getBrowserHeaders(referer = null) {
    return {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Referer': referer || 'https://wardyati.com/',
    };
}

// ================= إنشاء cloudscraper محسن (مثل curl_cffi) =================
function createEnhancedScraper() {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const scraper = cloudscraper.defaults({
        headers: {
            'User-Agent': ua,
        },
        agentOptions: {
            ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384', // TLS fingerprint لتجاوز الكشف
        },
        cloudflareTimeout: 10000, // زيادة الوقت لتجاوز التحديات
        challengesToSolve: 5, // محاولات أكثر
        followAllRedirects: true,
        gzip: true,
    });

    console.log(`تم إنشاء scraper جديد مع User-Agent: ${ua}`);
    return scraper;
}

// ================= دالة تأخير عشوائي =================
function randomDelay(minSec = 1, maxSec = 4) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (maxSec - minSec) * 1000 + minSec * 1000));
}

// ================= إعادة محاولة =================
const MAX_RETRIES = 5;
const BASE_DELAY = 7;

async function retry(func, ...args) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await func(...args);
        } catch (e) {
            const wait = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 5;
            console.error(`خطأ (${attempt}/${MAX_RETRIES}): ${e.message}`);
            if (attempt === MAX_RETRIES) {
                console.error("فشل نهائي...");
                return null;
            }
            console.warn(`إعادة المحاولة بعد ${wait.toFixed(1)} ثانية...`);
            await randomDelay(wait / 10, wait / 5); // مقياس صغير
        }
    }
    return null;
}

// ================= جلب ورديات الغد (باستخدام cloudscraper محسن) =================
async function fetchTomorrowShifts() {
    const tomorrow = addDays(new Date(), 1);
    const targetDate = format(tomorrow, "yyyy-MM-dd");
    const year = tomorrow.getFullYear();
    const month = tomorrow.getMonth() + 1;

    const scraper = createEnhancedScraper();

    try {
        // 1. جلب صفحة اللوجن + CSRF
        await randomDelay(2, 5);
        const loginPage = await retry(() => scraper.get("https://wardyati.com/login/", {
            headers: getBrowserHeaders(),
            resolveWithFullResponse: true,
        }));

        if (!loginPage) return null;

        const $ = cheerio.load(loginPage.body);
        let csrfToken = $('input[name="csrfmiddlewaretoken"]').val() || "";

        if (!csrfToken) {
            // البحث في الكوكيز إذا لزم
            const cookies = scraper.cookies.get_dict ? scraper.cookies.get_dict() : {};
            if (cookies.csrftoken) csrfToken = cookies.csrftoken;
        }

        if (!csrfToken) {
            console.error("لم يتم العثور على CSRF token");
            return null;
        }

        // 2. تسجيل الدخول
        await randomDelay(1, 3);
        const loginResp = await retry(() => scraper.post("https://wardyati.com/login/", {
            form: {
                username: LOGIN_EMAIL,
                password: LOGIN_PASSWORD,
                csrfmiddlewaretoken: csrfToken,
            },
            headers: getBrowserHeaders("https://wardyati.com/login/"),
            followAllRedirects: true,
        }));

        if (loginResp.statusCode !== 200 && loginResp.statusCode !== 302 || loginResp.body.includes('ممنوع') || loginResp.body.includes('403')) {
            console.error("فشل تسجيل الدخول");
            return null;
        }

        console.log("تم تسجيل الدخول بنجاح");

        // 3. جلب صفحة الغرف
        await randomDelay(1, 2);
        const homePage = await retry(() => scraper.get("https://wardyati.com/rooms/", {
            headers: getBrowserHeaders(),
        }));

        if (!homePage) return null;

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
        await randomDelay(0.5, 1.5);
        const arenaUrl = roomUrl + "arena/";
        const arenaResponse = await retry(() => scraper.get(arenaUrl, {
            qs: { view: "monthly", year, month },
            headers: getBrowserHeaders(roomUrl),
        }));

        if (!arenaResponse) return null;

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

            await randomDelay(0.5, 1.5);
            const detailsHtml = await retry(() => scraper.get(detailsUrl, {
                headers: { ...getBrowserHeaders(arenaUrl), "HX-Request": "true" },
            }));

            if (!detailsHtml) continue;

            try {
                const details = JSON.parse(detailsHtml);
                for (const h of details.holdings || []) {
                    const name = h.apparent_name || "غير معروف";
                    let phone = "";

                    if (h.urls?.get_member_info) {
                        await randomDelay(0.3, 1);
                        const memHtml = await retry(() => scraper.get("https://wardyati.com" + h.urls.get_member_info, {
                            headers: { ...getBrowserHeaders(detailsUrl), "HX-Request": "true" },
                        }));

                        if (memHtml) {
                            const memData = JSON.parse(memHtml);
                            phone = memData.room_member?.contact_info || "";
                        }
                    }

                    shifts[type] = shifts[type] || [];
                    shifts[type].push({ name, phone });
                }
            } catch (e) {
                console.error("خطأ في معالجة الشيفت:", e.message);
                continue;
            }
        }

        return { date: format(tomorrow, "EEEE dd/MM"), shifts };
    } catch (err) {
        console.error("فشل جلب الورديات:", err.message);
        return null;
    }
}

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

// إغلاق إذا لزم (بدون Puppeteer)
process.on('SIGINT', () => {
    process.exit();
});
