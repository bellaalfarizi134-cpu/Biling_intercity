'use strict';
const axios = require('axios');
const CITY = 'Malang';
const COUNTRY = 'Indonesia';
function isPrayerTimeQuestion(message) {
 const t = String(message || '').toLowerCase();
 const prayer = /\b(sholat|salat|shalat|sembahyang|prayer)\b/.test(t);
 const asksTime = /\b(waktu|jadwal|jam|pukul|masuk|berikutnya|sekarang|hari ini|subuh|dzuhur|zuhur|duhur|asar|ashar|maghrib|magrib|isya|isha)\b/.test(t);
 return prayer && asksTime || /\b(jadwal|waktu)\s+(subuh|fajar|dzuhur|zuhur|duhur|asar|ashar|maghrib|magrib|isya|isha)\b/.test(t) || /\b(subuh|fajar|dzuhur|zuhur|duhur|asar|ashar|maghrib|magrib|isya|isha)\s+(jam|pukul|berapa)\b/.test(t);
}
async function getAnswer(message) {
 const now = new Date();
 const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Jakarta',day:'2-digit',month:'2-digit',year:'numeric'}).formatToParts(now);
 const get = type => parts.find(p => p.type === type).value;
 const dateKey = `${get('day')}-${get('month')}-${get('year')}`;
 const response = await axios.get(`https://api.aladhan.com/v1/timingsByCity/${dateKey}`, {params:{city:CITY,country:COUNTRY,method:20},timeout:10000});
 const data = response.data && response.data.data;
 if (!data || !data.timings) throw new Error('Jadwal salat belum bisa diambil. Coba lagi sebentar.');
 const timings = data.timings;
 const rows = [['Subuh','Fajr'],['Dzuhur','Dhuhr'],['Ashar','Asr'],['Maghrib','Maghrib'],['Isya','Isha']];
 const fmt = key => String(timings[key] || '').slice(0,5);
 const list = rows.map(([name,key]) => `${name}: ${fmt(key)} WIB`).join('\n');
 const question = String(message || '').toLowerCase();
 const nowMins = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now).split(':')[0])*60 + Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now).split(':')[1]);
 const next = rows.map(([name,key])=>({name,time:fmt(key)})).filter(x=>/^\d{2}:\d{2}$/.test(x.time)).map(x=>({...x,mins:Number(x.time.slice(0,2))*60+Number(x.time.slice(3,5))})).find(x=>x.mins>=nowMins);
 const dateLabel = data.date && data.date.readable ? data.date.readable : `${get('day')}-${get('month')}-${get('year')}`;
 let answer = `Jadwal waktu salat hari ini — ${CITY}, WIB (${dateLabel}):\n${list}`;
 if (/\b(sekarang|berikutnya|masuk|sudah)\b/.test(question)) answer += next ? `\n\nSalat berikutnya menurut jadwal: ${next.name} pukul ${next.time} WIB.` : '\n\nJadwal salat hari ini sudah melewati waktu Isya; periksa jadwal hari berikutnya.';
 answer += '\n\nCatatan: jadwal perkiraan berdasarkan metode perhitungan layanan AlAdhan. Cocokkan dengan jadwal masjid setempat; bila lokasi berbeda dari Malang, sebutkan nama kota.';
 return answer;
}
module.exports = {isPrayerTimeQuestion,getAnswer};
