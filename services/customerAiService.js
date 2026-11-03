'use strict';
const fs = require('fs');
const axios = require('axios');
const db = require('../config/database');
const prayerTimeService = require('./prayerTimeService');

db.exec(`CREATE TABLE IF NOT EXISTS customer_ai_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),
 content TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (NOW_LOCAL())
);
CREATE INDEX IF NOT EXISTS idx_customer_ai_messages_customer_id ON customer_ai_messages(customer_id,id);`);

function config() {
 let f={}; try { f=JSON.parse(fs.readFileSync('/home/acs/.config/billing-rtrw/tech-ai.json','utf8')); } catch (_) {}
 return {
  geminiKey:String(process.env.GEMINI_API_KEY||f.apiKey||f.geminiApiKey||'').trim(),
  // Keep customer AI model independent from the technician/admin assistant model.
  // Gemini 3.8 Flash is the current stable general-purpose model; allow a customer-only override.
  geminiModel:String(process.env.CUSTOMER_GEMINI_MODEL||f.customerGeminiModel||'gemini-3.8-flash').trim(),
  groqKey:String(process.env.GROQ_API_KEY||f.groqApiKey||'').trim(),
  groqModel:String(process.env.GROQ_MODEL||f.groqModel||'llama-3.3-70b-versatile').trim(),
  routerKey:String(process.env.OPENROUTER_API_KEY||f.openrouterApiKey||'').trim(),
  routerModel:String(process.env.OPENROUTER_MODEL||f.openrouterModel||'openrouter/free').trim()
 };
}
function history(customerId) {
 return db.prepare("SELECT role,content FROM customer_ai_messages WHERE customer_id=? ORDER BY id DESC LIMIT 10").all(customerId).reverse();
}
async function askInternal({customerId,message,context}) {
 const text=String(message||'').trim().slice(0,1200);
 if(!text) throw new Error('Tulis pertanyaan dulu.');
 const old=history(Number(customerId));
 db.prepare("INSERT INTO customer_ai_messages(customer_id,role,content) VALUES(?,?,?)").run(Number(customerId),'user',text);
 if (prayerTimeService.isPrayerTimeQuestion(text)) {
  const answer = await prayerTimeService.getAnswer(text);
  db.prepare("INSERT INTO customer_ai_messages(customer_id,role,content) VALUES(?,?,?)").run(Number(customerId),'assistant',answer);
  return {answer};
 }
 const cfg=config();
 const prompt='Kamu adalah AI bantuan pelanggan ISP, terpisah dari AI teknisi. Jawab bahasa Indonesia dengan sopan dan ringkas. Bantu pertanyaan umum tentang tagihan, pembayaran, koneksi, dan layanan. Gunakan hanya ringkasan akun yang diberikan sistem. Jangan mengungkap data orang lain, rahasia, konfigurasi internal, kredensial, atau menjalankan perintah admin. Jangan mengarang status pembayaran/koneksi; jika data tidak tersedia, arahkan pelanggan menghubungi admin/support. Jangan meminta password atau OTP. Ringkasan akun pelanggan yang sedang login: '+JSON.stringify(context||{});
 const messages=[...old,{role:'user',content:text}].map(m=>({role:m.role,content:m.content}));
 const providers=[
  ...(cfg.geminiKey?[async()=>{const contents=messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));const r=await axios.post('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(cfg.geminiModel)+':generateContent',{systemInstruction:{parts:[{text:prompt}]},contents,generationConfig:{temperature:0.3,maxOutputTokens:450}},{timeout:25000,headers:{'x-goog-api-key':cfg.geminiKey}});return (r.data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();}]:[]),
  ...(cfg.groqKey?[async()=>{const r=await axios.post('https://api.groq.com/openai/v1/chat/completions',{model:cfg.groqModel,messages:[{role:'system',content:prompt},...messages],temperature:0.3,max_tokens:450},{timeout:25000,headers:{Authorization:'Bearer '+cfg.groqKey}});return String(r.data?.choices?.[0]?.message?.content||'').trim();}]:[]),
  ...(cfg.routerKey?[async()=>{const r=await axios.post('https://openrouter.ai/api/v1/chat/completions',{model:cfg.routerModel,messages:[{role:'system',content:prompt},...messages],temperature:0.3,max_tokens:450},{timeout:25000,headers:{Authorization:'Bearer '+cfg.routerKey}});return String(r.data?.choices?.[0]?.message?.content||'').trim();}]:[])
 ];
 if(!providers.length) throw new Error('Layanan AI belum dikonfigurasi. Hubungi administrator.');
 let answer='';
 for(const run of providers){try{answer=await run();if(answer)break;}catch(e){console.warn('[CUSTOMER AI] provider failed:',e.response?.status||'network');}}
 if(!answer) throw new Error('AI sedang tidak dapat menjawab. Coba lagi sebentar.');
 db.prepare("INSERT INTO customer_ai_messages(customer_id,role,content) VALUES(?,?,?)").run(Number(customerId),'assistant',answer);
 return {answer};
}
let activeRequests=0;
async function ask(args){activeRequests++;try{return await askInternal(args);}finally{activeRequests=Math.max(0,activeRequests-1);}}
function status(){return {activeRequests,capturedAt:new Date().toISOString()};}
function getHistory(customerId){return history(Number(customerId));}
module.exports={ask,getHistory,status};
