const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const { format, addDays } = require("date-fns");
const { toZonedTime } = require("date-fns-tz");
const pino = require("pino");
const { Session } = require("curl-cffi"); // ← هذا هو السلاح السري
const cheerio = require("cheerio");

// ================= إعدادات البوت =================
const LOGIN_EMAIL = "mm2872564@gmail.com";
const LOGIN_PASSWORD = "Mm@12345";
const ROOM_TEXT = "شيفتات جراحة غدد شهر 12"; // غيّر الشهر كل شهر
const TARGET_GROUP_ID = "120363410674115070@g.us"; // جروبك

let lastSentDate = null;
global.qrImage = null;

// بصمات متصفح حديثة (تحديث 2025)
const BROWSER_FINGERPRINTS = [
  "chrome124", "chrome123", "chrome122", "chrome120",
  "edge122", "edge120", "safari18_0", "safari17_5"
];

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTomorrowShifts() {
  const tomorrow = addDays(new Date(), 1);
  const targetDate = format(tomorrow, "yyyy-MM-dd");
  const year = tomorrow.getFullYear();
  const month = tomorrow.getMonth() + 1;

  // 3 محاولات ببصمات مختلفة
  for (let i = 0; i < 3; i++) {
    const fingerprint = BROWSER_FINGERPRINTS[Math.floor(Math.random() * BROWSER_FINGERPRINTS.length)];
    console.log(`محاولة ${i + 1} - استخدام بصمة: ${fingerprint}`);

    const session = new Session({
      impersonate: fingerprint,
      timeout: 30000,
    });

    try {
      // 1. جلب صفحة تسجيل الدخول
      await delay(2000 + Math.random() * 3000);
      let res = await session.get("https://wardyati.com/login/");
      if (res.status !== 200) continue;

      const $ = cheerio.load(res.data);
      let csrfToken = $('input[name="csrfmiddlewaretoken"]').val();

      // لو ما لقاش في الـ HTML، يجيبه من الكوكيز
      if (!csrfToken) {
        const cookies = await session.cookies.get("https://wardyati.com");
        const csrfCookie = cookies.find(c => c.name === "csrftoken");
        csrfToken = csrfCookie ? csrfCookie.value : null;
      }

      if (!csrfToken) {
        console.log("فشل استخراج CSRF token");
        continue;
      }

      console.log("تم استخراج CSRF token");

      // 2. تسجيل الدخول
      await delay(1500 + Math.random() * 2000);
      await session.post("https://wardyati.com/login/", {
        form: {
          username: LOGIN_EMAIL,
          password: LOGIN_PASSWORD,
          csrfmiddlewaretoken: csrfToken,
        },
        headers: {
          "Referer": "https://wardyati.com/login/",
        },
      });

      // فحص هل الدخول نجح ولا لأ
      const testRes = await session.get("https://wardyati.com/rooms/");
      if (testRes.status !== 200 || testRes.data.includes("تسجيل الدخول")) {
        console.log("فشل تسجيل الدخول");
        continue;
      }

      console.log("تم تسجيل الدخول بنجاح");

      // 3. جلب رابط الغرفة
      const $$ = cheerio.load(testRes.data);
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

      if (!roomUrl) {
        console.log("لم يتم العثور على الغرفة:", ROOM_TEXT);
        continue;
      }

      console.log("تم العثور على الغرفة:", roomUrl);

      // 4. جلب بيانات الشهر
      await delay(1000 + Math.random() * 2000);
      const arenaRes = await session.get(roomUrl + "arena/", {
        params: { view: "monthly", year, month },
      });

      if (arenaRes.status !== 200) continue;

      let data;
      try {
        data = JSON.parse(arenaRes.data);
      } catch (e) {
        console.log("فشل تحليل JSON من arena");
        continue;
      }

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

        await delay(800 + Math.random() * 1200);

        const detailsRes = await session.get(detailsUrl, {
          headers: { "HX-Request": "true" }
        });

        if (detailsRes.status !== 200) continue;

        let details;
        try {
          details = JSON.parse(detailsRes.data);
        } catch {
          continue;
        }

        for (const h of details.holdings || []) {
          const name = h.apparent_name || "غير معروف";
          let phone = "";

          if (h.urls?.get_member_info) {
            await delay(500 + Math.random() * 800);
            try {
              const memRes = await session.get("https://wardyati.com" + h.urls.get_member_info, {
                headers: { "HX-Request": "true" }
              });
              if (memRes.status === 200) {
                const memData = JSON.parse(memRes.data);
                phone = memData.room_member?.contact_info || "";
              }
            } catch (e) { /* تجاهل */ }
          }

          shifts[type] = shifts[type] || [];
          shifts[type].push({ name, phone });
        }
      }

      // نجاح! نرجع البيانات
      return { date: format(tomorrow, "EEEE dd/MM"), shifts };

    } catch (err) {
      console.log(`محاولة ${i + 1} فشلت:`, err.message);
      await delay(3000);
      continue;
    } finally {
      await session.close(); // مهم جدًا
    }
  }

  // لو وصلنا هنا يعني كل المحاولات فشلت
  console.log("فشل جلب الورديات بعد 3 محاولات");
  return null;
}

function formatMessage(result) {
  if (!result) return "فشل جلب ورديات الغد اليوم";

  if (result.message) {
    return `ورديات الغد\n${result.date}\n══════════════════════════════\n${result.message}`;
  }

  let text = `ورديات الغد\n${result.date}\n══════════════════════════════\n\n`;

  const order = ["Day", "Day Work", "Night"];
  const seen = new Set();

  for (const type of order) {
    if (result.shifts[type]) {
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

  // باقي الأنواع
  for (const type in result.shifts) {
    if (!order.includes(type)) {
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

  return text.trim();
}

// ================= باقي الكود (WhatsApp + QR) بدون تغيير =================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    version: [2, 3000, 1027934701],
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["WardYati Bot", "Chrome", "124.0"],
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
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
      console.log("تم الاتصال بنجاح! البوت شغال 24/7");
    }

    if (connection === "close") {
      const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("جاري إعادة الاتصال...");
        setTimeout(connectToWhatsApp, 5000);
      }
    }
  });

  // الجدولة اليومية (الساعة 10 صباحًا)
  setInterval(async () => {
    try {
      const nowEgypt = toZonedTime(new Date(), "Africa/Cairo");
      const hour = nowEgypt.getHours();
      const minute = nowEgypt.getMinutes();
      const todayStr = format(nowEgypt, "yyyy-MM-dd");

      if (hour === 10 && minute < 55 && lastSentDate !== todayStr) {
        console.log(`\n[${format(nowEgypt, "HH:mm:ss")}] جاري جلب ورديات الغد...`);

        const result = await fetchTomorrowShifts();

        if (result) {
          const message = formatMessage(result);
          await sock.sendMessage(TARGET_GROUP_ID, { text: message });
          console.log("تم إرسال الورديات بنجاح!");
        } else {
          await sock.sendMessage(TARGET_GROUP_ID, { text: "فشل جلب الورديات اليوم... سأحاول غدًا" });
        }

        lastSentDate = todayStr;
        console.log("-".repeat(60));
      }
    } catch (err) {
      console.error("خطأ في الجدولة:", err.message);
    }
  }, 10_000);
}

require("express")()
  .get("/", (req, res) => {
    res.send(global.qrImage
      ? `<center><h1>امسح الـ QR</h1><img src="${global.qrImage}" width="400"></center>`
      : `<h1>جاري توليد QR... انتظر</h1><script>setTimeout(()=>location.reload(),3000)</script>`
    );
  })
  .listen(5000, () => console.log("افتح: http://localhost:5000"));

connectToWhatsApp();
