const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const cloudscraper = require("cloudscraper");
const axios = require("axios");
const cheerio = require("cheerio");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");
const crypto = require("crypto");

// ================= إعدادات البوت =================
const LOGIN_EMAIL = "mm2872564@gmail.com";
const LOGIN_PASSWORD = "Mm@12345";
const ROOM_TEXT = "شيفتات جراحة غدد شهر 12";
const TARGET_GROUP_ID = "120363410674115070@g.us";

let lastSentDate = null;
global.qrImage = null;

// ================= إعدادات محسنة للـ User-Agent =================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

// ================= إعدادات متقدمة للـ cloudscraper =================
function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders(referer = null) {
    const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
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
        'User-Agent': getRandomUserAgent(),
    };
    
    if (referer) {
        headers['Referer'] = referer;
    }
    
    return headers;
}

function randomDelay(min = 1000, max = 4000) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

// ================= دالة محسنة لجلب البيانات =================
async function fetchWithRetry(url, options = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await randomDelay(1000, 3000);
            
            const response = await cloudscraper({
                url,
                method: options.method || 'GET',
                headers: getBrowserHeaders(options.referer),
                formData: options.formData,
                qs: options.qs,
                jar: true, // مهم للحفاظ على الكوكيز
                followAllRedirects: true,
                timeout: 30000,
                ...options,
            });
            
            return response;
        } catch (error) {
            console.error(`محاولة ${i + 1}/${retries} فشلت لـ ${url}:`, error.message);
            
            if (i === retries - 1) {
                throw error;
            }
            
            await randomDelay(2000, 5000);
        }
    }
}

// ================= جلب ورديات الغد =================
async function fetchTomorrowShifts() {
    const tomorrow = addDays(new Date(), 1);
    const targetDate = format(tomorrow, "yyyy-MM-dd");
    const year = tomorrow.getFullYear();
    const month = tomorrow.getMonth() + 1;

    try {
        console.log(`بدء جلب ورديات تاريخ: ${targetDate}`);
        
        // 1. جلب صفحة تسجيل الدخول
        console.log("جاري زيارة صفحة تسجيل الدخول...");
        const loginPage = await fetchWithRetry("https://wardyati.com/login/", {
            referer: "https://wardyati.com/",
        });
        
        const $ = cheerio.load(loginPage);
        
        // البحث عن CSRF token بعدة طرق
        let csrfToken = $('input[name="csrfmiddlewaretoken"]').val();
        
        if (!csrfToken) {
            // محاولة البحث في meta tags
            csrfToken = $('meta[name="csrf-token"]').attr('content');
        }
        
        if (!csrfToken) {
            console.error("لم يتم العثور على CSRF token!");
            return null;
        }
        
        console.log("تم العثور على CSRF token");
        
        // 2. تسجيل الدخول
        console.log("جاري تسجيل الدخول...");
        await fetchWithRetry("https://wardyati.com/login/", {
            method: "POST",
            referer: "https://wardyati.com/login/",
            formData: {
                username: LOGIN_EMAIL,
                password: LOGIN_PASSWORD,
                csrfmiddlewaretoken: csrfToken,
            }
        });
        
        console.log("تم تسجيل الدخول بنجاح ✓");
        await randomDelay(2000, 4000);
        
        // 3. جلب صفحة الغرف
        console.log("جاري زيارة صفحة الغرف...");
        const homePage = await fetchWithRetry("https://wardyati.com/rooms/", {
            referer: "https://wardyati.com/login/",
        });
        
        const $$ = cheerio.load(homePage);
        let roomUrl = null;

        // البحث عن الغرفة المطلوبة
        $$('div.overflow-wrap').each((i, el) => {
            if ($$(el).text().includes(ROOM_TEXT)) {
                const link = $$(el).closest('.card-body').find('a.stretched-link').attr('href');
                if (link) {
                    roomUrl = link.startsWith("http") ? link : "https://wardyati.com" + link;
                    console.log(`تم العثور على الغرفة: ${roomUrl}`);
                    return false;
                }
            }
        });

        if (!roomUrl) {
            console.error(`لم يتم العثور على الغرفة! تأكد من النص: ${ROOM_TEXT}`);
            return null;
        }
        
        await randomDelay(1000, 2000);

        // 4. جلب بيانات الشهر
        console.log("جاري جلب بيانات الشهر...");
        const arenaUrl = roomUrl + "arena/";
        const arenaResponse = await fetchWithRetry(arenaUrl, {
            qs: { view: "monthly", year, month },
            referer: roomUrl,
            headers: {
                ...getBrowserHeaders(roomUrl),
                'HX-Request': 'true',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        let data;
        try {
            data = JSON.parse(arenaResponse);
        } catch (e) {
            console.error("فشل تحليل JSON:", e.message);
            return null;
        }

        if (!data.shift_instances_by_date?.[targetDate]) {
            console.log(`لا توجد ورديات للتاريخ: ${targetDate}`);
            return {
                date: format(tomorrow, "EEEE dd/MM"),
                message: "لا توجد ورديات الغد (إجازة أو لم تُحدد بعد)"
            };
        }

        console.log(`تم العثور على ${data.shift_instances_by_date[targetDate].length} وردية`);
        
        // 5. جلب تفاصيل الورديات
        const shifts = {};
        const shiftInstances = data.shift_instances_by_date[targetDate];
        
        for (let i = 0; i < shiftInstances.length; i++) {
            const shift = shiftInstances[i];
            const type = shift.shift_type_name || "Unknown";
            
            console.log(`جاري جلب تفاصيل وردية ${i + 1}/${shiftInstances.length} (${type})`);
            
            const detailsUrl = "https://wardyati.com" + shift.get_shift_instance_details_url;
            
            try {
                await randomDelay(500, 1500);
                
                const detailsHtml = await fetchWithRetry(detailsUrl, {
                    headers: {
                        ...getBrowserHeaders(arenaUrl),
                        "HX-Request": "true",
                        "HX-Current-URL": arenaUrl,
                        "X-Requested-With": "XMLHttpRequest"
                    }
                });
                
                const details = JSON.parse(detailsHtml);
                shifts[type] = shifts[type] || [];

                for (const h of details.holdings || []) {
                    const name = h.apparent_name || "غير معروف";
                    let phone = "";

                    if (h.urls?.get_member_info) {
                        try {
                            await randomDelay(300, 1000);
                            
                            const memHtml = await fetchWithRetry(
                                "https://wardyati.com" + h.urls.get_member_info, 
                                {
                                    headers: {
                                        "HX-Request": "true",
                                        "X-Requested-With": "XMLHttpRequest"
                                    }
                                }
                            );
                            
                            const memData = JSON.parse(memHtml);
                            phone = memData.room_member?.contact_info || "";
                        } catch (e) {
                            console.log(`فشل جلب معلومات العضو: ${name}`);
                        }
                    }
                    
                    shifts[type].push({ name, phone });
                }
            } catch (e) {
                console.error(`خطأ في جلب تفاصيل وردية ${type}:`, e.message);
                continue;
            }
        }

        return { 
            date: format(tomorrow, "EEEE dd/MM"), 
            shifts,
            rawDate: targetDate
        };
        
    } catch (err) {
        console.error("فشل جلب الورديات:", err.message);
        return null;
    }
}

// ================= تنسيق الرسالة =================
function formatMessage(result) {
    if (!result) return "❌ فشل جلب ورديات الغد اليوم";

    if (result.message) {
        return `📅 ورديات الغد\n${result.date}\n══════════════════════════════\n${result.message}`;
    }

    let text = `📅 ورديات الغد\n${result.date}\n`;
    text += "══════════════════════════════\n\n";

    const order = ["Day", "Day Work", "Night"];
    const seen = new Set();

    // الورديات الرئيسية بالترتيب
    for (const type of order) {
        if (result.shifts?.[type] && result.shifts[type].length > 0) {
            text += `🟢 ${type}\n`;
            
            const uniquePeople = [];
            const seenNames = new Set();
            
            for (const p of result.shifts[type]) {
                if (!seenNames.has(p.name)) {
                    uniquePeople.push(p);
                    seenNames.add(p.name);
                }
            }
            
            for (const p of uniquePeople) {
                if (p.phone) {
                    text += `• ${p.name} (${p.phone})\n`;
                } else {
                    text += `• ${p.name}\n`;
                }
            }
            text += "\n";
            seen.add(type);
        }
    }

    // الأنواع الأخرى
    for (const type in result.shifts) {
        if (!seen.has(type) && result.shifts[type].length > 0) {
            text += `🟡 ${type}\n`;
            
            const uniquePeople = [];
            const seenNames = new Set();
            
            for (const p of result.shifts[type]) {
                if (!seenNames.has(p.name)) {
                    uniquePeople.push(p);
                    seenNames.add(p.name);
                }
            }
            
            for (const p of uniquePeople) {
                if (p.phone) {
                    text += `• ${p.name} (${p.phone})\n`;
                } else {
                    text += `• ${p.name}\n`;
                }
            }
            text += "\n";
        }
    }

    if (text.trim().endsWith("══════════════════════════════")) {
        text += "\nلا توجد ورديات مسجلة للغد";
    }

    return text.trim();
}

// ================= بدء الاتصال بواتساب =================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const version = [2, 3000, 1027934701];

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
            console.log("📱 تم توليد QR جديد! امسحه بسرعة:");
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    global.qrImage = url;
                    console.log("🔗 افتح الرابط لرؤية الـ QR: http://localhost:5000");
                }
            });
        }

        if (connection === "open") {
            console.log("✅ تم الاتصال بنجاح بواتساب!");
            console.log("🤖 البوت جاهز لإرسال ورديات الغد يوميًا في الوقت المحدد");
        }

        if (connection === "close") {
            const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(shouldReconnect ? "⚠️ انقطع الاتصال... جاري إعادة الاتصال" : "🚫 تم تسجيل الخروج");
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });

    // ================= الجدولة اليومية =================
    setInterval(async () => {
        try {
            const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
            const hour = nowEgypt.getHours();
            const minute = nowEgypt.getMinutes();
            const todayStr = format(nowEgypt, "yyyy-MM-dd");

            // تشغيل الساعة 2:30 مساءً (14:30) بتوقيت مصر
            if (hour === 18 && minute >= 1 && minute < 60 && lastSentDate !== todayStr) {
                console.log(`\n⏰ [${format(nowEgypt, "HH:mm:ss")}] وقت جلب ورديات الغد...`);
                console.log("─".repeat(60));

                const result = await fetchTomorrowShifts();

                if (result) {
                    const message = formatMessage(result);
                    await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                    console.log("✅ تم إرسال ورديات الغد بنجاح إلى الجروب!");
                    
                    // طباعة ملخص في الكونسول
                    if (result.shifts) {
                        let total = 0;
                        for (const type in result.shifts) {
                            total += result.shifts[type].length;
                        }
                        console.log(`📊 إجمالي الأسماء: ${total}`);
                    }
                } else {
                    await sock.sendMessage(TARGET_GROUP_ID, { 
                        text: "❌ فشل جلب ورديات الغد اليوم... سأحاول غدًا إن شاء الله" 
                    });
                    console.log("❌ فشل جلب الورديات");
                }

                console.log("─".repeat(60));
                lastSentDate = todayStr;
                
                // الانتظار 30 دقيقة قبل التحقق مجدداً
                await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));
            }
        } catch (err) {
            console.error("⚠️ خطأ في الجدولة:", err.message);
        }
    }, 60000); // التحقق كل دقيقة

    return sock;
}

// ================= سيرفر عرض الـ QR =================
const express = require("express");
const app = express();

app.get("/", (req, res) => {
    res.send(global.qrImage
        ? `<html>
            <head>
                <title>واتساب ورديات الغد</title>
                <meta charset="UTF-8">
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        text-align: center; 
                        padding: 50px; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        min-height: 100vh;
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                    }
                    h1 { 
                        font-size: 2.5em; 
                        margin-bottom: 20px;
                        text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
                    }
                    .qr-container {
                        background: white;
                        padding: 20px;
                        border-radius: 15px;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                        margin: 20px 0;
                    }
                    img {
                        border-radius: 10px;
                        max-width: 300px;
                    }
                    .info {
                        background: rgba(255,255,255,0.1);
                        padding: 15px;
                        border-radius: 10px;
                        margin-top: 20px;
                        max-width: 500px;
                    }
                </style>
            </head>
            <body>
                <h1>📱 امسح الـ QR بسرعة!</h1>
                <p style="font-size: 1.2em; margin-bottom: 20px;">لربط البوت بحساب واتساب</p>
                <div class="qr-container">
                    <img src="${global.qrImage}" alt="QR Code" width="400">
                </div>
                <div class="info">
                    <p>⏰ البوت سيرسل ورديات الغد تلقائيًا يوميًا في الساعة 2:30 مساءً</p>
                    <p>📅 المجموعة المستهدفة: ${TARGET_GROUP_ID}</p>
                </div>
                <script>
                    // تحديث الصفحة كل 5 ثواني
                    setTimeout(() => location.reload(), 5000);
                </script>
            </body>
           </html>`
        : `<html>
            <head>
                <title>واتساب ورديات الغد</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        text-align: center; 
                        padding: 50px; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        min-height: 100vh;
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                    }
                    h1 { 
                        font-size: 2.5em; 
                        margin-bottom: 20px;
                    }
                    .loader {
                        border: 8px solid #f3f3f3;
                        border-top: 8px solid #3498db;
                        border-radius: 50%;
                        width: 60px;
                        height: 60px;
                        animation: spin 2s linear infinite;
                        margin: 20px;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            </head>
            <body>
                <h1>⏳ جاري توليد الـ QR...</h1>
                <div class="loader"></div>
                <p>انتظر قليلاً، سيظهر الـ QR قريبًا</p>
                <script>
                    setTimeout(() => location.reload(), 3000);
                </script>
            </body>
           </html>`
    );
});

app.listen(5000, () => console.log("🌐 افتح الرابط لرؤية الـ QR: http://localhost:5000"));

// ================= بدء البوت =================
console.log("🚀 بدء تشغيل بوت ورديات الغد...");
connectToWhatsApp();

// ================= معالجة الأخطاء غير المتوقعة =================
process.on("uncaughtException", (error) => {
    console.error("💥 خطأ غير متوقع:", error);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 وعد مرفوض:", reason);
});
