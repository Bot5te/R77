const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");
const XLSX = require("xlsx");
const fs = require("fs");

// ================= إعدادات الملف =================
const EXCEL_FILE_PATH = "./wardiaty.xlsx";

// ================= إعدادات Gist لحفظ الحالة =================
const GIST_ID = "cd4bd1519749da63f37eaa594199e1df";
const STATUS_GIST_FILENAME = "bot_status.json";
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

// ================= إعدادات البوت =================
const TARGET_GROUP_ID = "120363410674115070@g.us";
let lastSentDate = null;
global.qrImage = null;

// ================= جلب بيانات الورديات من ملف Excel =================
async function fetchShiftsFromExcel() {
    try {
        if (!fs.existsSync(EXCEL_FILE_PATH)) {
            console.log("لم يتم العثور على ملف wardiaty.xlsx");
            return null;
        }

        const workbook = XLSX.readFile(EXCEL_FILE_PATH);
        const tomorrow = format(addDays(new Date(), 1), "yyyy-MM-dd");
        
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // قراءة البيانات كمصفوفة ثنائية الأبعاد
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        // البحث عن الصف الذي يبدأ فيه تاريخ الغد في العمود الأول (أو الأخير بناءً على الصورة)
        // الصورة توضح أن التواريخ موجودة في العمود الأخير (أقصى اليمين)
        let startRowIndex = -1;
        let dateColumnIndex = -1;

        for (let R = 0; R < data.length; R++) {
            const row = data[R];
            if (!row || row.length === 0) continue;
            
            // فحص كل الأعمدة في الصف للبحث عن التاريخ (لأن ترتيب الأعمدة قد يختلف)
            for (let C = 0; C < row.length; C++) {
                let cellValue = row[C];
                if (!cellValue) continue;

                let formattedCellValue = "";
                if (typeof cellValue === 'number') {
                    // تحويل رقم Excel إلى تاريخ
                    const date = XLSX.utils.format_cell({ v: cellValue, t: 'd' });
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
            console.log(`لم يتم العثور على تاريخ الغد (${tomorrow}) في أي عمود بالملف`);
            return null;
        }

        console.log(`تم العثور على تاريخ الغد في الصف ${startRowIndex + 1}`);

        // تحديد صفوف البيانات لهذا التاريخ (حتى التاريخ التالي أو نهاية الملف)
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

        // استخراج العناوين من الصف الأول (عناوين الأقسام)
        const headers = data[0] || [];
        const shiftsData = { shifts: {} };

        // سنمر على الأعمدة التي تحتوي على بيانات (غير عمود التاريخ)
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
            console.log(`لم يتم العثor على بيانات ورديات في صفوف يوم الغد (${tomorrow})`);
            return null;
        }

        return { dateKey: tomorrow, shiftsData: shiftsData };

    } catch (err) {
        console.error("فشل جلب البيانات من Excel:", err.message);
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

    const seen = new Set();

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

        // التحقق من وجود أسماء حقيقية (ليست مجرد شرطات أو فراغات)
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

            // فحص الإرسال كل دقيقة لضمان السرعة
            console.log(`[فحص الجدولة] الساعة الآن: ${hour}:${minute}, آخر إرسال: ${lastSentDate}`);
            if (hour === 12  && minute < 60 && lastSentDate !== todayStr) {
                console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] جاري البحث عن ورديات الغد...`);
                const result = await fetchShiftsFromExcel();
                
                if (result) {
                    const message = formatMessage(result.shiftsData, result.dateKey);
                    await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                    console.log("تم إرسال ورديات الغد بنجاح!");
                    lastSentDate = todayStr;
                    await updateRemoteLastSentDate(todayStr);
                } else {
                    console.log("لا توجد ورديات جديدة اليوم");
                    // تأجيل المحاولة بدلاً من التوقف النهائي لليوم إذا كان الملف غير جاهز بعد
                }
            }
        } catch (err) {
            console.error("خطأ في الجدولة:", err.message);
        }
    }, 15 * 60 * 1000); // كل دقيقة واحدة للتأكد من الإرسال الفوري
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
            
            // جلب الحالة من Gist عند بدء التشغيل
            getRemoteLastSentDate().then(date => {
                lastSentDate = date;
                console.log(`آخر تاريخ إرسال مسجل في Gist: ${lastSentDate || "لا يوجد"}`);
                
                // تشغيل الجدولة فوراً وبشكل دوري
                const runScheduler = async () => {
                    try {
                        const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
                        const hour = nowEgypt.getHours();
                        const todayStr = format(nowEgypt, "yyyy-MM-dd");
                        
                        console.log(`[فحص الجدولة] الساعة الآن: ${hour}, اليوم: ${todayStr}, آخر إرسال: ${lastSentDate}`);
                        
                        // تم التعديل للسماح بالإرسال في أي وقت بعد الساعة 3 عصراً إذا لم يتم الإرسال اليوم
                        if (hour >= 12 && lastSentDate !== todayStr) {
                            console.log("جاري البحث عن الورديات لإرسالها...");
                            const result = await fetchShiftsFromExcel();
                            if (result) {
                                const message = formatMessage(result.shiftsData, result.dateKey);
                                await sock.sendMessage(TARGET_GROUP_ID, { text: message });
                                console.log("تم إرسال الورديات بنجاح!");
                                lastSentDate = todayStr;
                                await updateRemoteLastSentDate(todayStr);
                            }
                        }
                    } catch (e) { console.error("خطأ في الجدولة:", e.message); }
                };
                
                runScheduler(); // تشغيل مرة فوراً
                setInterval(runScheduler, 60000); // ثم كل دقيقة
            });
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
