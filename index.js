import cloudscraper
from bs4 import BeautifulSoup
import json
from urllib.parse import urljoin
from datetime import datetime, timedelta
import pytz
import time
import random
import logging
import traceback
from app import server 

# ================= إعداد Logging ليعمل ممتاز على Render =================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger(__name__)

# لضمان ظهور كل شيء في Render Logs حتى لو كان هناك buffering
import sys
sys.stdout.reconfigure(line_buffering=True)

# ================= إعدادات إعادة المحاولة =================
MAX_RETRIES = 5
BASE_DELAY = 7

def retry(func):
    def wrapper(*args, **kwargs):
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                wait = BASE_DELAY * (2 ** (attempt - 1)) + random.uniform(0, 5)
                now = datetime.now(pytz.timezone('Africa/Cairo')).strftime('%H:%M:%S')
                tb = traceback.format_exc()
                log.error(f"[{now}] خطأ ({attempt}/{MAX_RETRIES}): {e}\n{tb}")
                if attempt == MAX_RETRIES:
                    log.error("فشل نهائي في هذه الخطوة، ننتقل...")
                    return None
                log.warning(f"إعادة المحاولة بعد {wait:.1f} ثانية...")
                time.sleep(wait)
        return None
    return wrapper

def get_egypt_time():
    return datetime.now(pytz.timezone('Africa/Cairo'))

# قائمة User-Agent عشوائية لتقليد متصفحات مختلفة
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
]

def get_random_headers(referer=None):
    headers = {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    }
    if referer:
        headers['Referer'] = referer
    return headers

@retry
def safe_get(scraper, url, **kwargs):
    headers = get_random_headers(kwargs.get('referer'))
    log.info(f"GET → {url} | params={kwargs.get('params')} | headers={headers}")
    time.sleep(random.uniform(1, 3))  # تأخير عشوائي بشري
    resp = scraper.get(url, timeout=25, headers=headers, **kwargs)
    log.info(f"← {resp.status_code} من {url}")
    resp.raise_for_status()
    return resp

@retry
def safe_post(scraper, url, **kwargs):
    headers = get_random_headers(kwargs.get('referer'))
    log.info(f"POST → {url} | headers={headers}")
    time.sleep(random.uniform(1, 3))  # تأخير عشوائي بشري
    resp = scraper.post(url, timeout=25, headers=headers, **kwargs)
    if resp.status_code not in (200, 302):
        raise Exception(f"فشل POST: {resp.status_code} | {resp.text[:500]}")
    log.info(f"← {resp.status_code} بعد POST")
    return resp

def fetch_and_print_shifts():
    log.info("=== بدء جلب ورديات الغد ===")
    try:
        # إنشاء scraper مع خيارات لتجاوز الحماية
        scraper = cloudscraper.create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'desktop': True
            },
            delay=5,  # إبطاء لتجنب الكشف
            interpreter='js2py',  # للتعامل مع تحديات JS إذا وجدت
            debug=True  # لتسجيل تفاصيل للتشخيص
        )

        # 1. تسجيل الدخول
        login_page = safe_get(scraper, 'https://wardyati.com/login/', referer='https://wardyati.com/')
        if not login_page:
            return False

        soup = BeautifulSoup(login_page.text, 'html.parser')
        csrf = soup.find('input', {'name': 'csrfmiddlewaretoken'})
        csrf_token = csrf['value'] if csrf else ''
        if not csrf_token:
            log.error("لم يتم العثور على csrf token")
            return False

        login_data = {
            'username': 'mm2872564@gmail.com',
            'password': 'Mm@12345',
            'csrfmiddlewaretoken': csrf_token,
        }

        login_resp = safe_post(scraper, 'https://wardyati.com/login/', data=login_data,
                               referer='https://wardyati.com/login/', allow_redirects=True)
        if not login_resp or 'ممنوع' in login_resp.text or '403' in login_resp.text:
            log.error("فشل تسجيل الدخول - ربما تم حظر الـ IP أو تغيّر الكود")
            log.error(f"جزء من الرد: {login_resp.text[:1000]}")
            return False

        log.info("تم تسجيل الدخول بنجاح")

        # باقي الكود كما هو مع إضافة log في كل خطوة مهمة
        home = safe_get(scraper, 'https://wardyati.com/rooms/', referer='https://wardyati.com/login/')
        if not home:
            return False

        soup = BeautifulSoup(home.text, 'html.parser')
        target_text = 'شيفتات جراحة غدد شهر 12'
        room_link = None
        for div in soup.find_all('div', class_='overflow-wrap'):
            if target_text in div.text.strip():
                card = div.find_parent('div', class_='card-body')
                if card:
                    a = card.find('a', class_='stretched-link')
                    if a:
                        room_link = urljoin('https://wardyati.com/', a.get('href'))
                        log.info(f"تم العثور على الغرفة: {room_link}")
                        break

        if not room_link:
            log.error("لم يتم العثور على الغرفة - تأكد من النص 'شيفتات جراحة غدد شهر 12'")
            return False

        tomorrow = get_egypt_time() + timedelta(days=1)
        target_date = tomorrow.strftime('%Y-%m-%d')
        target_year = tomorrow.year
        target_month = tomorrow.month

        arena_url = urljoin(room_link, 'arena/')
        arena_resp = safe_get(scraper, arena_url, params={
            'view': 'monthly',
            'year': target_year,
            'month': target_month
        }, referer=room_link)
        if not arena_resp:
            return False

        try:
            data = json.loads(arena_resp.text)
            log.info(f"تم جلب بيانات الشهر بنجاح - عدد الأيام: {len(data.get('shift_instances_by_date', {}))}")
        except Exception as e:
            log.error(f"فشل تحليل JSON من arena: {e}")
            log.error(f"الرد الخام: {arena_resp.text[:1000]}")
            return False

        if target_date not in data.get('shift_instances_by_date', {}):
            day_name = tomorrow.strftime('%A')
            formatted = tomorrow.strftime('%d/%m')
            log.info(f"لا توجد ورديات يوم الغد: {day_name} {formatted}")
            return True

        # باقي الكود مع try/except حول كل جزء حساس
        shifts_by_type = {}
        for shift in data['shift_instances_by_date'][target_date]:
            shift_type = shift.get('shift_type_name', 'Unknown')
            details_url = urljoin('https://wardyati.com/', shift['get_shift_instance_details_url'])

            details_resp = safe_get(scraper, details_url, headers={'HX-Request': 'true'}, referer=arena_url)
            if not details_resp:
                continue

            try:
                details = json.loads(details_resp.text)
                for h in details.get('holdings', []):
                    name = h.get('apparent_name', 'غير معروف')
                    phone = ''
                    member_url = h.get('urls', {}).get('get_member_info')
                    if member_url:
                        mem_resp = safe_get(scraper, urljoin('https://wardyati.com/', member_url),
                                            headers={'HX-Request': 'true'}, referer=details_url)
                        if mem_resp:
                            try:
                                mdata = json.loads(mem_resp.text)
                                phone = mdata.get('room_member', {}).get('contact_info', '')
                            except:
                                pass
                    shifts_by_type.setdefault(shift_type, []).append({'name': name, 'phone': phone})
            except Exception as e:
                log.error(f"خطأ أثناء معالجة تفاصيل الشيفت: {e}")

        # طباعة النتيجة النهائية
        day_name = tomorrow.strftime('%A')
        formatted = tomorrow.strftime('%d/%m')
        log.info(f"\nورديات الغد: {day_name} {formatted}")
        log.info("=" * 50)

        order = ['Day', 'Day Work', 'Night']
        printed = set()

        for st in order + list(shifts_by_type.keys()):
            if st in shifts_by_type and st not in printed:
                log.info(f"\n{st}")
                seen = set()
                for p in shifts_by_type[st]:
                    key = (p['name'], p['phone'])
                    if key not in seen:
                        seen.add(key)
                        log.info(f'"{p["name"]}')
                        if p['phone']:
                            log.info(f'({p["phone"]})')
                printed.add(st)

        log.info("=" * 50)
        return True

    except Exception as e:
        log.error("خطأ غير متوقع في fetch_and_print_shifts:")
        log.error(traceback.format_exc())
        return False

# ================= الحلقة الرئيسية =================
def main():
    log.info("البوت شغال الآن - يطبع ورديات الغد يوميًا")
    log.info("-" * 70)

    last_printed_date = None

    while True:
        try:
            now = get_egypt_time()
            current_date = now.strftime('%Y-%m-%d')
            current_hour = now.hour
            current_minute = now.minute

            if current_hour == 14 and current_minute < 30 and last_printed_date != current_date:
                log.info(f"[{now.strftime('%H:%M:%S')}] جاري جلب ورديات الغد...")
                success = fetch_and_print_shifts()
                if success:
                    last_printed_date = current_date
                log.info("-" * 60)

            time.sleep(20)

        except Exception as e:
            log.error("خطأ في الحلقة الرئيسية:")
            log.error(traceback.format_exc())
            time.sleep(10)

if __name__ == "__main__":
    server()          # يشتغل الـ web server إذا كان موجود
    try:
        main()
    except KeyboardInterrupt:
        log.info("تم إيقاف البوت يدويًا")
    except Exception as e:
        log.error(f"خطأ فادح: {e}")
        log.error(traceback.format_exc())
