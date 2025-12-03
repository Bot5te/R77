const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const cheerio = require("cheerio");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");
const fetch = (...args) => import('node-fetch').then(module => module.default(...args));                 // أضف السطر ده بعده

// ================= إعدادات البوت =================
const LOGIN_EMAIL = "mm2872564@gmail.com";
const LOGIN_PASSWORD = "Mm@12345";
const ROOM_TEXT = "شيفتات جراحة غدد شهر 12"; // غيّر الشهر كل شهر
const TARGET_GROUP_ID = "120363410674115070@g.us";

// رابط FlareSolverr بتاعك (شغال دلوقتي)
const FLARESOLVERR_URL = "https://flaresolverr-up4g.onrender.com";

let lastSentDate = null;
global.qrImage = null;

// ================= Bypass Cloudflare باستخدام FlareSolverr =================
async function requestViaFlareSolverr(url, options = {}) {
    const payload = {
        cmd: "request.get",
        url: url,
        maxTimeout: 60000,
        ...options
    };

    const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.status !== "ok") {
        throw new Error(`FlareSolverr Error: ${data.message || JSON.stringify(data)}`);
    }
    return data.solution; // { response, status, cookies, headers, userAgent }
}

async function postViaFlareSolverr(url, formData, headers = {}) {
    const payload = {
        cmd: "request.post",
        url: url,
        postData: new URLSearchParams(formData).toString(),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...headers
        },
        maxTimeout: 60000
    };

    const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.status !== "ok") throw new Error(`POST Error: ${data.message}`);
    return data.solution;
}

// ================= إعادة المحاولة القوية =================
async function retry(fn) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const wait = 7 * Math.pow(2, attempt - 1) + Math.random() * 5;
            const now = format(toZonedTime(new Date(), "Africa/Cairo"), "HH:mm:ss");
            console.log(`[${now}] خطأ (${attempt}/5): ${err.message}`);
            if (attempt === 5) {
                console.log("فشل نهائي، بننتقل...");
                return null;
            }
            console.log(`إعادة المحاولة بعد ${wait.toFixed(1)} ثانية...`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
}

// ================= جلب ورديات الغد =================
async function fetchTomorrowShifts() {
    return await retry(async () => {
        const tomorrow = addDays(new Date(), 1);
        const targetDate = format(tomorrow, "yyyy-MM-dd");
        const year = tomorrow.getFullYear();
        const month = tomorrow.getMonth() + 1;

        // 1. جلب صفحة اللوجن + csrf
        const loginPage = await requestViaFlareSolverr("https://wardyati.com/login/");
        const $ = cheerio.load(loginPage.response);
        const csrf = $('input[name="csrfmiddlewaretoken"]').val();

        if (!csrf) throw new Error("لم يتم العثور على csrf token");

        // 2. تسجيل الدخول
        await postViaFlareSolverr("https://wardyati.com/login/", {
            username: LOGIN_EMAIL,
            password: LOGIN_PASSWORD,
            csrfmiddlewaretoken: csrf
        }, { Referer: "https://wardyati.com/login/" });

        console.log("تم تسجيل الدخول بنجاح");

        // 3. البحث عن الغرفة
        const homePage = await requestViaFlareSolverr("https://wardyati.com/rooms/");
        const $$ = cheerio.load(homePage.response);
        let roomUrl = null;

        $$('div.overflow-wrap').each((i, el) => {
            if ($$(el).text().includes(ROOM_TEXT)) {
                const href = $$(el).closest('.card-body').find('a.stretched-link').attr('href');
                if (href) {
                    roomUrl = href.startsWith("http") ? href : "https://wardyati.com" + href;
                    return false;
                }
            }
        });

        if (!roomUrl) throw new Error("الغرفة مش موجودة – تأكد من اسم الشهر");

        // 4. جلب بيانات الشهر
        const arenaResp = await requestViaFlareSolverr(roomUrl + "arena/", {
            qs: { view: "monthly", year, month }
        });

        const data = JSON.parse(arenaResp.response);

        if (!data.shift_instances_by_date?.[targetDate]) {
            return { date: format(tomorrow, "EEEE dd/MM"), message: "لا توجد ورديات الغد (إجازة أو لم تُحدد بعد)" };
        }

        const shifts = {};

        for (const shift of data.shift_instances_by_date[targetDate]) {
            const type = shift.shift_type_name || "Unknown";
            const detailsUrl = "https://wardyati.com" + shift.get_shift_instance_details_url;

            try {
                const detailsResp = await requestViaFlareSolverr(detailsUrl, {
                    headers: { "HX-Request": "true" }
                });
                const details = JSON.parse(detailsResp.response);

                for (const h of details.holdings || []) {
                    const name = h.apparent_name || "غير معروف";
                    let phone = "";

                    if (h.urls?.get_member_info) {
                        try {
                            const memResp = await requestViaFlareSolverr("https://wardyati.com" + h.urls.get_member_info, {
                                headers: { "HX-Request": "true" }
                            });
                            const memData = JSON.parse(memResp.response);
                            phone = memData.room_member?.contact_info || "";
                        } catch { }
                    }

                    shifts[type] = shifts[type] || [];
                    shifts[type].push({ name, phone });
                }
            } catch (e) {
                console.log("فشل جلب تفاصيل شيفت واحد، بنكمل الباقي...");
            }
        }

        return { date: format(tomorrow, "EEEE dd/MM"), shifts };
    });
}

// ================= تنسيق الرسالة =================
function formatMessage(r) {
    if (r.message) {
        return `ورديات الغد\n${r.date}\n══════════════════════════════\n${r.message}`;
    }

    let text = `ورديات الغد\n${r.date}\n══════════════════════════════\n\n`;
    const order = ["Day", "Day Work", "Night"];
    const seen = new Set();

    for (const type of order) {
        if (r.shifts[type]) {
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

    return text.trim();
}

// ================= باقي البوت (QR + WhatsApp) =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Chrome (Linux)", "", ""],
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
        const { connection, qr } = update;
        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                global.qrImage = url;
                console.log("QR جاهز → http://localhost:5000");
            });
        }
        if (connection === "open") {
            console.log("البوت متصل بواتساب وشغال 24/7");

            setInterval(async () => {
                try {
                    const now = toZonedTime(new Date(), "Africa/Cairo");
                    const hour = now.getHours();
                    const minute = now.getMinutes();
                    const dateStr = format(now, "yyyy-MM-dd");

                    if (hour === 19 && minute < 59 && lastSentDate !== dateStr) {
                        console.log(`[${format(now, "HH:mm:ss")}] جاري جلب ورديات الغد...`);
                        const result = await fetchTomorrowShifts();
                        const message = result ? formatMessage(result) : "فشل جلب الورديات النهاردة";

                        await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                        console.log("تم الإرسال بنجاح!");
                        lastSentDate = dateStr;
                    }
                } catch (err) {
                    console.error("خطأ في الجدولة:", err.message);
                }
            }, 60000);
        }
        if (connection === "close" && update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            startBot();
        }
    });
}

// سيرفر الـ QR
require("express")().get("/", (req, res) => {
    res.send(global.qrImage
        ? `<h1 style="text-align:center;color:green">امسح الـ QR!</h1><center><img src="${global.qrImage}"></center>`
        : `<h1>جاري توليد QR...</h1><script>setTimeout(() => location.reload(), 3000);</script>`
    );
}).listen(5000, () => console.log("QR: http://localhost:5000"));

// حماية من السقوط
process.on("uncaughtException", () => setTimeout(startBot, 5000));
process.on("unhandledRejection", () => setTimeout(startBot, 5000));

startBot();
