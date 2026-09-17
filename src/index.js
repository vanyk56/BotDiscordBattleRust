import 'dotenv/config';
import {createServer} from 'node:http';
import {Client,GatewayIntentBits,EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,Events,PermissionFlagsBits,SlashCommandBuilder,ActivityType,ModalBuilder,TextInputBuilder,TextInputStyle,ContainerBuilder,TextDisplayBuilder,MessageFlags} from 'discord.js';
import {GameDig} from 'gamedig';

for(const key of ['DISCORD_TOKEN','RUST_API_URL','RUST_API_SECRET']) if(!process.env[key]) throw new Error(`Не задано ${key}`);
const brand=process.env.BRAND_NAME||'BattleRust';
const color=parseInt(process.env.BRAND_COLOR||'E25B2A',16);
const apiBase=process.env.RUST_API_URL.replace(/\/$/,'');
const client=new Client({intents:[GatewayIntentBits.Guilds]});
const statusMessages=new Map(), votes=new Map(), localLinks=new Map();
const pendingClaims=[];
const startedAt=new Date();
let pushedServerState=null, wipeChannelId=process.env.WIPE_CHANNEL_ID||'', wipeTimer=null;

const slashCommands=[
 new SlashCommandBuilder().setName('setup').setDescription('Закрепить меню BattleRust').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('setup-ideas').setDescription('Закрепить панель предложений в этом канале').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('setup-info').setDescription('Закрепить информацию о сервере').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('setup-rules').setDescription('Опубликовать и закрепить правила').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('setup-wipe').setDescription('Назначить канал автоматических уведомлений о вайпе').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('wipe-now').setDescription('Отправить уведомление о вайпе сейчас').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('status').setDescription('Статус сервера BattleRust'),
 new SlashCommandBuilder().setName('link').setDescription('Привязать Steam ID').addStringOption(o=>o.setName('code').setDescription('Код /link из игры').setRequired(true)),
 new SlashCommandBuilder().setName('stats').setDescription('Статистика игрока').addUserOption(o=>o.setName('user').setDescription('Discord-пользователь')),
 new SlashCommandBuilder().setName('top').setDescription('Таблица лидеров').addStringOption(o=>o.setName('category').setDescription('Категория').setRequired(true).addChoices({name:'Убийства',value:'kills'},{name:'K/D',value:'kd'},{name:'Онлайн',value:'playtime'},{name:'Фарм',value:'farm'},{name:'Рейды',value:'raids'},{name:'Очки',value:'score'})),
 new SlashCommandBuilder().setName('idea').setDescription('Предложить идею').addStringOption(o=>o.setName('text').setDescription('Опишите идею').setRequired(true).setMaxLength(1000))
].map(c=>c.toJSON());

// Railway выдаёт PORT автоматически и проверяет HTTP endpoint перед активацией deploy.
const healthServer=createServer((req,res)=>{
 if(req.url==='/ingest'&&req.method==='POST'){
  if(req.headers['x-battlerust-secret']!==process.env.RUST_API_SECRET){res.writeHead(401);return res.end('unauthorized');}
  let body='';req.on('data',chunk=>{if(body.length<5000000)body+=chunk;});req.on('end',()=>{try{const data=JSON.parse(body);pushedServerState={...data,receivedAt:Date.now()};for(const [discordId,steamId] of Object.entries(data.links||{}))localLinks.set(discordId,String(steamId));const claims=pendingClaims.splice(0);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({claims}));}catch{res.writeHead(400);res.end('invalid json');}});return;
 }
 if(req.url!=='/'&&req.url!=='/health'){res.writeHead(404);return res.end('not found');}
 const ready=client.isReady();
 res.writeHead(ready?200:503,{'Content-Type':'application/json; charset=utf-8'});
 res.end(JSON.stringify({status:ready?'ok':'starting',service:'battlerust-discord-bot',discord:ready,startedAt:startedAt.toISOString()}));
});
healthServer.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Health server: 0.0.0.0:${process.env.PORT||3000}`));

async function api(path,options={}){
 let response;
 try { response=await fetch(`${apiBase}${path}`,{...options,signal:options.signal||AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','X-BattleRust-Secret':process.env.RUST_API_SECRET,...options.headers}}); }
 catch { throw new Error('Нет связи с API игрового сервера. Проверьте RUST_API_URL и порт 28110.'); }
 const body=await response.json().catch(()=>({}));
 if(!response.ok) throw new Error(body.error||`API ${response.status}`);
 return body;
}
function freshStats(){return pushedServerState&&Date.now()-pushedServerState.receivedAt<120000&&Array.isArray(pushedServerState.stats);}
async function statsForDiscord(discordId){
 if(freshStats()){const steamId=localLinks.get(discordId)||String((pushedServerState.links||{})[discordId]||'');const player=pushedServerState.stats.find(p=>String(p.steamId)===steamId);if(player)return player;if(!steamId)throw new Error('Steam ID не привязан. Получите код командой /link в игре.');}
 return api(`/api/stats/discord/${discordId}`);
}
async function topFromSource(category,limit){
 if(freshStats()){const value=p=>category==='kd'?(p.deaths?p.kills/p.deaths:p.kills):category==='playtime'?p.playtimeSeconds:category==='farm'?p.totalFarm:category==='raids'?p.totalRaids:category==='kills'?p.kills:p.score;const label=(p,v)=>category==='playtime'?`${Math.floor(v/86400)}д ${Math.floor(v%86400/3600)}ч ${Math.floor(v%3600/60)}м`:category==='kd'||category==='score'?Number(v).toFixed(2):Number(v).toLocaleString('ru-RU');return{players:[...pushedServerState.stats].sort((a,b)=>value(b)-value(a)).slice(0,limit).map(p=>({...p,value:value(p),valueLabel:label(p,value(p))}))};}
 return api(`/api/top?category=${encodeURIComponent(category)}&limit=${limit}`);
}
async function claimSteam(code,discordId){
 if(freshStats()&&pushedServerState.codes&&pushedServerState.codes[code]){const entry=pushedServerState.codes[code],steamId=String(entry.steamId||entry.SteamId),expiresAt=Number(entry.expiresAt||entry.ExpiresAt||0);if(expiresAt&&expiresAt<Math.floor(Date.now()/1000))throw new Error('Код истёк. Создайте новый командой /link в игре.');const player=pushedServerState.stats.find(p=>String(p.steamId)===steamId);localLinks.set(discordId,steamId);pendingClaims.push({code,discordId});delete pushedServerState.codes[code];return{name:player?.name||steamId,steamId};}
 return api('/api/link/claim',{method:'POST',body:JSON.stringify({code,discordId})});
}
async function queryServer(){
 if(pushedServerState&&Date.now()-pushedServerState.receivedAt<45000){
  const s=pushedServerState;
  return{online:true,name:s.name||brand,map:s.map||'Procedural Map',players:Number(s.players||0),max:Number(s.maxPlayers||150),joining:Number(s.joining||0),sleepers:Number(s.sleepers||0),ping:null,connect:s.connect||`${process.env.RUST_HOST}:${process.env.RUST_CONNECT_PORT}`,source:'BattleRust Live'};
 }
 if(process.env.RUST_HOST){
  try{
   const s=await GameDig.query({type:'rust',host:process.env.RUST_HOST,port:Number(process.env.RUST_QUERY_PORT||20636),maxAttempts:2,socketTimeout:4000});
   return{online:true,name:s.name||brand,map:s.map||'—',players:Number(s.numplayers||0),max:Number(s.maxplayers||0),ping:s.ping,connect:`${process.env.RUST_HOST}:${process.env.RUST_CONNECT_PORT||20635}`,source:'Live Query'};
  }catch(e){console.warn(`Прямой Query недоступен: ${e.message}; пробую GameMonitoring`);}
 }
 if(process.env.GAMEMONITORING_SERVER_ID){
  try{
   const response=await fetch(`https://api.gamemonitoring.ru/servers/${encodeURIComponent(process.env.GAMEMONITORING_SERVER_ID)}`,{signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw new Error(`GameMonitoring ${response.status}`);
   const json=await response.json(),s=json.response||json;
   return{online:Boolean(s.status),name:s.name||brand,map:s.map||s.map_name||'—',players:Number(s.numplayers||0),max:Number(s.maxplayers||0),ping:null,connect:s.connect||`${s.ip}:${s.port}`,source:'GameMonitoring (резерв)'};
  }catch(e){console.warn(`GameMonitoring недоступен: ${e.message}`);}
 }
 return{online:false,name:brand,map:'—',players:0,max:0,ping:null};
}
async function statusEmbed(){
 const s=await queryServer(),address=s.connect||`${process.env.RUST_HOST||'127.0.0.1'}:${process.env.RUST_CONNECT_PORT||28015}`,connect=`connect ${address}`;
 return new EmbedBuilder().setColor(s.online?0x43b581:0xed4245).setTitle(`${s.online?'🟢':'🔴'} ${s.name}`).setDescription(s.online?`Сервер работает\n\`${connect}\``:'Сервер сейчас недоступен').addFields({name:'Онлайн',value:`${s.players}/${s.max}`,inline:true},{name:'Карта',value:s.map||'—',inline:true},{name:'Пинг',value:s.ping==null?'—':`${s.ping} мс`,inline:true}).setFooter({text:`${brand} • ${s.source||'прямой Query'} • обновлено`}).setTimestamp();
}
function menuRows(){return[new ActionRowBuilder().addComponents(
 new ButtonBuilder().setCustomId('br_top').setLabel('Топ-5 игроков').setStyle(ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('br_stats').setLabel('Моя статистика').setStyle(ButtonStyle.Secondary))];}
function statsPanel(){return new ContainerBuilder().setAccentColor(0xa8e063).addTextDisplayComponents(new TextDisplayBuilder().setContent('### Статистика\nВыберите действие ниже.')).addActionRowComponents(menuRows()[0]);}
function ideasPanel(){const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('idea_open').setLabel('Предложить идею').setStyle(ButtonStyle.Secondary));return new ContainerBuilder().setAccentColor(0xa8e063).addTextDisplayComponents(new TextDisplayBuilder().setContent('### Идеи и предложения\nПредложите изменение или новую возможность для сервера. После публикации участники смогут проголосовать.')).addActionRowComponents(row);}
function infoPanel(){return new ContainerBuilder().setAccentColor(0xa8e063).addTextDisplayComponents(new TextDisplayBuilder().setContent('@everyone\n### Информация о сервере\n[Telegram](https://t.me/xdaitt123)\n\n**Вайпы**\nКаждые 48 часов в 17:00\n\n**Подключение к серверу**\n`connect 157.85.95.155:20635`'));}
const fmt=s=>`${Math.floor(s/3600)}ч ${Math.floor(s%3600/60)}м`;
function statsEmbed(p){
 const kd=p.deaths?(p.kills/p.deaths).toFixed(2):p.kills.toFixed(2);
 return new EmbedBuilder().setColor(0xa8e063).setTitle(p.name).setDescription(`Steam ID: \`${p.steamId}\``).addFields(
 {name:'PVP',value:`Убийств: **${p.kills}**\nСмертей: **${p.deaths}**\nK/D: **${kd}**`,inline:true},
 {name:'Активность',value:`Онлайн: **${fmt(p.playtimeSeconds)}**\nОчки: **${p.score.toFixed(2)}**`,inline:true},
 {name:'Ресурсы',value:`Добыто: **${p.totalFarm.toLocaleString('ru-RU')}**\nВзрывчатки: **${p.totalRaids.toLocaleString('ru-RU')}**`,inline:true},
 {name:'Другое',value:`Ящиков: ${p.cratesOpened}\nБочек: ${p.barrelsDestroyed}\nЖивотных: ${p.animalsKilled}\nNPC: ${p.npcKilled}`}).setFooter({text:brand}).setTimestamp();
}
async function myStats(i,id=i.user.id){try{await i.reply({embeds:[statsEmbed(await statsForDiscord(id))],ephemeral:true});}catch(e){if(!i.replied&&!i.deferred)return i.showModal(linkModal());throw e;}}
async function top(i,category='score',limit=10){
 try{const d=await topFromSource(category,limit),names={kills:'убийствам',kd:'K/D',playtime:'онлайну',farm:'фарму',raids:'рейдам',score:'очкам'};const lines=d.players.map((p,n)=>`**${n+1}.** ${p.name} — **${p.valueLabel}**`).join('\n')||'Данных пока нет.';await i.reply({embeds:[new EmbedBuilder().setColor(0xa8e063).setTitle(`Топ-${limit} по ${names[category]||category}`).setDescription(lines).setFooter({text:brand})],ephemeral:true});}
 catch(e){await i.reply({content:`Не удалось получить топ: ${e.message}`,ephemeral:true});}
}
function ideaRow(up,down){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('idea_up').setLabel(String(up)).setEmoji('✅').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('idea_down').setLabel(String(down)).setEmoji('❌').setStyle(ButtonStyle.Secondary));}
function ideaEmbed(text,userId){const safe=String(text).replace(/```/g,'ʼʼʼ');return new EmbedBuilder().setColor(0xa8e063).setTitle('Идея').setDescription(`\`\`\`\n${safe}\n\`\`\``).addFields({name:'Создано',value:`<@${userId}>`}).setFooter({text:`${brand} • Голосование`}).setTimestamp();}
function linkModal(){return new ModalBuilder().setCustomId('link_modal').setTitle('Привязать Steam ID').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('link_code').setLabel('Код привязки Steam ID').setPlaceholder('Получите код командой /link в игре').setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(6).setRequired(true)));}
function ideaModal(){return new ModalBuilder().setCustomId('idea_modal').setTitle('Предложить идею').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('idea_text').setLabel('Описание идеи').setPlaceholder('Опишите предложение для сервера').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));}

client.once(Events.ClientReady,async c=>{
 console.log(`${brand}: бот запущен как ${c.user.tag}; сборка ${process.env.BOT_BUILD||'dev'}; команд в коде ${slashCommands.length}`);
 try{
  if(process.env.DISCORD_GUILD_ID){const guild=await c.guilds.fetch(process.env.DISCORD_GUILD_ID);await guild.commands.set(slashCommands);console.log(`Команды зарегистрированы на сервере ${guild.name}: ${slashCommands.length}`);}
  else{await c.application.commands.set(slashCommands);console.log(`Глобальные команды зарегистрированы: ${slashCommands.length}`);}
 }catch(e){console.error(`Не удалось зарегистрировать slash-команды: ${e.message}`);}
 scheduleWipes();
 const refresh=async()=>{
  const server=await queryServer();
  const extra=server.joining==null?'':` Play_${server.players} Join_${server.joining} Sleep_${server.sleepers}`;
  c.user.setPresence({activities:[{name:`${server.players}/${server.max}${extra||' • Play'}`,type:ActivityType.Playing}],status:server.online?'online':'dnd'});
  const embed=await statusEmbed();
  for(const[k,r]of statusMessages){try{const ch=await client.channels.fetch(r.channelId),m=await ch.messages.fetch(r.messageId);await m.edit({embeds:[embed]});}catch{statusMessages.delete(k);}}
 };
 await refresh();
 setInterval(refresh,Math.max(30,Number(process.env.STATUS_INTERVAL_SECONDS||60))*1000).unref();
});
client.on(Events.InteractionCreate,async i=>{try{
 if(i.isChatInputCommand()){
  if(i.commandName==='setup'){if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))return i.reply({content:'Нужно право «Управлять сервером».',ephemeral:true});const m=await i.channel.send({components:[statsPanel()],flags:MessageFlags.IsComponentsV2});await m.pin().catch(()=>null);return i.reply({content:'Панель статистики опубликована и закреплена.',ephemeral:true});}
  if(i.commandName==='setup-ideas'){const m=await i.channel.send({components:[ideasPanel()],flags:MessageFlags.IsComponentsV2});await m.pin().catch(()=>null);return i.reply({content:'Панель идей опубликована и закреплена в этом канале.',ephemeral:true});}
  if(i.commandName==='setup-info'){const m=await i.channel.send({components:[infoPanel()],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:['everyone']}});await m.pin().catch(()=>null);return i.reply({content:'Информация опубликована, @everyone упомянут и сообщение закреплено.',ephemeral:true});}
  if(i.commandName==='setup-rules'){const m=await i.channel.send({components:[rulesPanel()],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:['everyone']}});await m.pin().catch(()=>null);return i.reply({content:'Правила опубликованы, @everyone упомянут и сообщение закреплено.',ephemeral:true});}
  if(i.commandName==='setup-wipe'){wipeChannelId=i.channelId;scheduleWipes();const m=await i.channel.send({components:[wipeSchedulePanel(nextWipeTimestamp())],flags:MessageFlags.IsComponentsV2});await m.pin().catch(()=>null);return i.reply({content:'Канал авторассылки настроен. Для сохранения после перезапуска добавьте в Railway: WIPE_CHANNEL_ID='+i.channelId,ephemeral:true});}
  if(i.commandName==='wipe-now'){await i.deferReply({ephemeral:true});await sendWipeAnnouncement(i.channelId);return i.editReply({content:'Объявление о вайпе отправлено.'});}
  if(i.commandName==='status')return i.reply({embeds:[await statusEmbed()]});
  if(i.commandName==='stats')return myStats(i,i.options.getUser('user')?.id||i.user.id);
  if(i.commandName==='top')return top(i,i.options.getString('category'));
  if(i.commandName==='link'){const r=await claimSteam(i.options.getString('code'),i.user.id);return i.reply({content:`Steam-профиль ${r.name} успешно привязан.`,ephemeral:true});}
  if(i.commandName==='idea'){await i.reply({embeds:[ideaEmbed(i.options.getString('text'),i.user.id)],components:[ideaRow(0,0)]});const m=await i.fetchReply();votes.set(m.id,new Map());return;}
 }
 if(i.isButton()){
  if(i.customId==='br_stats')return myStats(i);
  if(i.customId==='br_top')return top(i,'score',5);
  if(i.customId==='br_open_link')return i.showModal(linkModal());
  if(i.customId==='idea_open')return i.showModal(ideaModal());
  if(i.customId.startsWith('idea_')){const map=votes.get(i.message.id)||new Map(),choice=i.customId==='idea_up'?'up':'down';map.set(i.user.id,choice);votes.set(i.message.id,map);let up=0,down=0;for(const v of map.values())v==='up'?up++:down++;return i.update({components:[ideaRow(up,down)]});}
 }
 if(i.isModalSubmit()){
  if(i.customId==='link_modal'){const code=i.fields.getTextInputValue('link_code');await i.deferReply({ephemeral:true});const r=await claimSteam(code,i.user.id);return i.editReply({content:`Steam-профиль ${r.name} успешно привязан.`});}
  if(i.customId==='idea_modal'){await i.reply({embeds:[ideaEmbed(i.fields.getTextInputValue('idea_text'),i.user.id)],components:[ideaRow(0,0)]});const m=await i.fetchReply();votes.set(m.id,new Map());return;}
 }
}catch(e){console.error(e);const p={content:`Ошибка: ${e.message}`,ephemeral:true};if(i.deferred&&!i.replied)await i.editReply({content:p.content}).catch(()=>null);else if(i.replied||i.deferred)await i.followUp(p).catch(()=>null);else await i.reply(p).catch(()=>null);}});
client.login(process.env.DISCORD_TOKEN);

async function shutdown(signal){console.log(`${signal}: корректное завершение`);healthServer.close();client.destroy();process.exit(0);}
process.once('SIGTERM',()=>shutdown('SIGTERM'));
process.once('SIGINT',()=>shutdown('SIGINT'));

const WIPE_START_MS=Date.UTC(2026,8,17,14),WIPE_INTERVAL_MS=172800000;
function nextWipeTimestamp(n=Date.now()){return n<WIPE_START_MS?WIPE_START_MS:WIPE_START_MS+(Math.floor((n-WIPE_START_MS)/WIPE_INTERVAL_MS)+1)*WIPE_INTERVAL_MS;}
function formatMoscow(t){return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'long',timeStyle:'short'}).format(new Date(t));}
function rulesPanel(){const q=String.fromCharCode(96),b=['# 📚 Правила','','Правила едины для всех наших серверов. Незнание правил не освобождает от наказания.','Спорные ситуации решает администрация — с обязательным объяснением решения.','','▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬','','### 🚫 Строго запрещено',q+q+q+'diff','- Читы и стороннее ПО','- Отказ от проверки','- Багоюз и дюп','- Обход блокировки',q+q+q,'','**Читы** — бан навсегда при подтверждённом детекте.','**Отказ от проверки** приравнивается к читам.','**Обход бана** — срок удваивается, дополнительный аккаунт блокируется навсегда.','','### 💬 Запрещено в общении','• Оскорбления, переход на личности и упоминание родных','• Национальная и религиозная вражда','• Реклама других проектов в чате и никах','• Вымогательство и обман новичков вне игровой логики','','### ⚔️ Разрешено','Рейды, обманы внутри игры, союзы и предательства, засады у спавна.','*Это Rust — здесь так и задумано.*','','### ⚖️ Наказания',q+'1'+q+' нарушение → предупреждение или мут',q+'2'+q+' нарушение → бан от суток',q+'читы / багоюз'+q+' → перманентная блокировка сразу','','### 🛡️ Ваши гарантии','Каждый бан — с доказательствами.','Ошибочное решение можно обжаловать через поддержку.','Администраторский произвол рассматривается отдельно.','','**Есть вопросы**','Discord: <@1396809640846557247>','Telegram: '+q+'@koxxxymiron'+q,'','||@everyone||'].join('\n');return new ContainerBuilder().setAccentColor(0xa8e063).addTextDisplayComponents(new TextDisplayBuilder().setContent(b));}
function wipePanel(){const q=String.fromCharCode(96),b=['# Battle Rust — вайп завершён','','На сервере **Battle Rust** произошёл плановый вайп. Мир обновлён и готов к новому старту.','','**Стартовый бонус**','Первые 10 игроков получат приятный бонус на старте.','','**Подключение к серверу**',q+'connect 157.85.95.155:20635'+q,'','**Дополнительный бонус**','Добавьте '+q+'#BattleRust'+q+' к игровому имени и получите бонус на сервере.','','Желаем удачного старта и приятной игры.','','@everyone'].join('\n');return new ContainerBuilder().setAccentColor(0xa8e063).addTextDisplayComponents(new TextDisplayBuilder().setContent(b));}
function wipeSchedulePanel(t){return new ContainerBuilder().setAccentColor(0xa8e063).addTextDisplayComponents(new TextDisplayBuilder().setContent('# Расписание вайпов\n\nАвтоматическая рассылка настроена на этот канал.\n\n**Следующий вайп:** '+formatMoscow(t)+' по московскому времени\n**Периодичность:** каждые 2 дня в 17:00'));}
async function sendWipeAnnouncement(id=wipeChannelId){if(!id)throw new Error('Канал вайпов не настроен. Используйте /setup-wipe.');const ch=await client.channels.fetch(id);if(!ch?.isTextBased())throw new Error('Канал недоступен.');return ch.send({components:[wipePanel()],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:['everyone']}});}
function scheduleWipes(){if(wipeTimer)clearTimeout(wipeTimer);if(!wipeChannelId){console.log('Авторассылка вайпов ожидает /setup-wipe или WIPE_CHANNEL_ID.');return;}const n=nextWipeTimestamp();console.log('Следующая рассылка о вайпе: '+formatMoscow(n));wipeTimer=setTimeout(async()=>{try{await sendWipeAnnouncement();}catch(e){console.error(e);}finally{scheduleWipes();}},Math.max(1000,n-Date.now()));wipeTimer.unref?.();}
