import 'dotenv/config';
import {createServer} from 'node:http';
import {Client,GatewayIntentBits,EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,Events,PermissionFlagsBits,SlashCommandBuilder,ActivityType} from 'discord.js';
import {GameDig} from 'gamedig';

for(const key of ['DISCORD_TOKEN','RUST_API_URL','RUST_API_SECRET']) if(!process.env[key]) throw new Error(`Не задано ${key}`);
const brand=process.env.BRAND_NAME||'BattleRust';
const color=parseInt(process.env.BRAND_COLOR||'E25B2A',16);
const apiBase=process.env.RUST_API_URL.replace(/\/$/,'');
const client=new Client({intents:[GatewayIntentBits.Guilds]});
const statusMessages=new Map(), votes=new Map();
const startedAt=new Date();

const slashCommands=[
 new SlashCommandBuilder().setName('setup').setDescription('Закрепить меню BattleRust').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('status').setDescription('Статус сервера BattleRust'),
 new SlashCommandBuilder().setName('link').setDescription('Привязать Steam ID').addStringOption(o=>o.setName('code').setDescription('Код /link из игры').setRequired(true)),
 new SlashCommandBuilder().setName('stats').setDescription('Статистика игрока').addUserOption(o=>o.setName('user').setDescription('Discord-пользователь')),
 new SlashCommandBuilder().setName('top').setDescription('Таблица лидеров').addStringOption(o=>o.setName('category').setDescription('Категория').setRequired(true).addChoices({name:'Убийства',value:'kills'},{name:'K/D',value:'kd'},{name:'Онлайн',value:'playtime'},{name:'Фарм',value:'farm'},{name:'Рейды',value:'raids'},{name:'Очки',value:'score'})),
 new SlashCommandBuilder().setName('idea').setDescription('Предложить идею').addStringOption(o=>o.setName('text').setDescription('Опишите идею').setRequired(true).setMaxLength(1000))
].map(c=>c.toJSON());

// Railway выдаёт PORT автоматически и проверяет HTTP endpoint перед активацией deploy.
const healthServer=createServer((req,res)=>{
 if(req.url!=='/'&&req.url!=='/health'){res.writeHead(404);return res.end('not found');}
 const ready=client.isReady();
 res.writeHead(ready?200:503,{'Content-Type':'application/json; charset=utf-8'});
 res.end(JSON.stringify({status:ready?'ok':'starting',service:'battlerust-discord-bot',discord:ready,startedAt:startedAt.toISOString()}));
});
healthServer.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Health server: 0.0.0.0:${process.env.PORT||3000}`));

async function api(path,options={}){
 const response=await fetch(`${apiBase}${path}`,{...options,headers:{'Content-Type':'application/json','X-BattleRust-Secret':process.env.RUST_API_SECRET,...options.headers}});
 const body=await response.json().catch(()=>({}));
 if(!response.ok) throw new Error(body.error||`API ${response.status}`);
 return body;
}
async function queryServer(){
 if(process.env.GAMEMONITORING_SERVER_ID){
  try{
   const response=await fetch(`https://api.gamemonitoring.ru/servers/${encodeURIComponent(process.env.GAMEMONITORING_SERVER_ID)}`,{signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw new Error(`GameMonitoring ${response.status}`);
   const json=await response.json(),s=json.response||json;
   return{online:Boolean(s.status),name:s.name||brand,map:s.map||s.map_name||'—',players:Number(s.numplayers||0),max:Number(s.maxplayers||0),ping:null,connect:s.connect||`${s.ip}:${s.port}`,source:'GameMonitoring'};
  }catch(e){console.warn(`GameMonitoring недоступен: ${e.message}; пробую прямой Query`);}
 }
 try{const s=await GameDig.query({type:'rust',host:process.env.RUST_HOST||'127.0.0.1',port:Number(process.env.RUST_QUERY_PORT||28017),maxAttempts:2,socketTimeout:3000});return{online:true,name:s.name,map:s.map,players:s.numplayers,max:s.maxplayers,ping:s.ping};}
 catch{return{online:false,name:brand,map:'—',players:0,max:0,ping:0};}
}
async function statusEmbed(){
 const s=await queryServer(),address=s.connect||`${process.env.RUST_HOST||'127.0.0.1'}:${process.env.RUST_CONNECT_PORT||28015}`,connect=`connect ${address}`;
 return new EmbedBuilder().setColor(s.online?0x43b581:0xed4245).setTitle(`${s.online?'🟢':'🔴'} ${s.name}`).setDescription(s.online?`Сервер работает\n\`${connect}\``:'Сервер сейчас недоступен').addFields({name:'Онлайн',value:`${s.players}/${s.max}`,inline:true},{name:'Карта',value:s.map||'—',inline:true},{name:'Пинг',value:s.ping==null?'—':`${s.ping} мс`,inline:true}).setFooter({text:`${brand} • ${s.source||'прямой Query'} • обновлено`}).setTimestamp();
}
function menuRows(){return[new ActionRowBuilder().addComponents(
 new ButtonBuilder().setCustomId('br_status').setLabel('Статус').setEmoji('📡').setStyle(ButtonStyle.Success),
 new ButtonBuilder().setCustomId('br_stats').setLabel('Моя статистика').setEmoji('📊').setStyle(ButtonStyle.Primary),
 new ButtonBuilder().setCustomId('br_top').setLabel('Топ игроков').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('br_link').setLabel('Привязать Steam').setEmoji('🔗').setStyle(ButtonStyle.Secondary))];}
const fmt=s=>`${Math.floor(s/3600)}ч ${Math.floor(s%3600/60)}м`;
function statsEmbed(p){
 const kd=p.deaths?(p.kills/p.deaths).toFixed(2):p.kills.toFixed(2);
 return new EmbedBuilder().setColor(color).setTitle(`📊 ${p.name}`).setDescription(`Steam ID: \`${p.steamId}\``).addFields(
 {name:'PVP',value:`Убийств: **${p.kills}**\nСмертей: **${p.deaths}**\nK/D: **${kd}**`,inline:true},
 {name:'Активность',value:`Онлайн: **${fmt(p.playtimeSeconds)}**\nОчки: **${p.score.toFixed(2)}**`,inline:true},
 {name:'Ресурсы',value:`Добыто: **${p.totalFarm.toLocaleString('ru-RU')}**\nВзрывчатки: **${p.totalRaids.toLocaleString('ru-RU')}**`,inline:true},
 {name:'Другое',value:`Ящиков: ${p.cratesOpened}\nБочек: ${p.barrelsDestroyed}\nЖивотных: ${p.animalsKilled}\nNPC: ${p.npcKilled}`}).setFooter({text:brand}).setTimestamp();
}
async function myStats(i,id=i.user.id){try{await i.reply({embeds:[statsEmbed(await api(`/api/stats/discord/${id}`))],ephemeral:true});}catch(e){await i.reply({content:`Аккаунт не привязан. В игре: \`/link\`, затем здесь: \`/link code:КОД\`.\n${e.message}`,ephemeral:true});}}
async function top(i,category='score'){
 try{const d=await api(`/api/top?category=${encodeURIComponent(category)}&limit=10`),names={kills:'убийствам',kd:'K/D',playtime:'онлайну',farm:'фарму',raids:'рейдам',score:'очкам'};const lines=d.players.map((p,n)=>`**${n+1}.** ${p.name} — **${p.valueLabel}**`).join('\n')||'Данных пока нет.';await i.reply({embeds:[new EmbedBuilder().setColor(color).setTitle(`🏆 Топ-10 по ${names[category]||category}`).setDescription(lines).setFooter({text:brand})],ephemeral:true});}
 catch(e){await i.reply({content:`Не удалось получить топ: ${e.message}`,ephemeral:true});}
}
function ideaRow(up,down){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('idea_up').setLabel(String(up)).setEmoji('✅').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('idea_down').setLabel(String(down)).setEmoji('❌').setStyle(ButtonStyle.Secondary));}

client.once(Events.ClientReady,async c=>{
 console.log(`${brand}: бот запущен как ${c.user.tag}`);
 try{
  if(process.env.DISCORD_GUILD_ID){const guild=await c.guilds.fetch(process.env.DISCORD_GUILD_ID);await guild.commands.set(slashCommands);console.log(`Команды зарегистрированы на сервере ${guild.name}: ${slashCommands.length}`);}
  else{await c.application.commands.set(slashCommands);console.log(`Глобальные команды зарегистрированы: ${slashCommands.length}`);}
 }catch(e){console.error(`Не удалось зарегистрировать slash-команды: ${e.message}`);}
 const refresh=async()=>{
  const server=await queryServer();
  c.user.setPresence({activities:[{name:`${server.players}/${server.max} • Play`,type:ActivityType.Playing}],status:server.online?'online':'dnd'});
  const embed=await statusEmbed();
  for(const[k,r]of statusMessages){try{const ch=await client.channels.fetch(r.channelId),m=await ch.messages.fetch(r.messageId);await m.edit({embeds:[embed]});}catch{statusMessages.delete(k);}}
 };
 await refresh();
 setInterval(refresh,Math.max(30,Number(process.env.STATUS_INTERVAL_SECONDS||60))*1000).unref();
});
client.on(Events.InteractionCreate,async i=>{try{
 if(i.isChatInputCommand()){
  if(i.commandName==='setup'){if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))return i.reply({content:'Нужно право «Управлять сервером».',ephemeral:true});const m=await i.channel.send({embeds:[new EmbedBuilder().setColor(color).setTitle(`${brand} • Игровая панель`).setDescription('Статус сервера, статистика, лидеры и привязка Steam ID.')],components:menuRows()});await m.pin().catch(()=>null);statusMessages.set(m.id,{channelId:m.channelId,messageId:m.id});return i.reply({content:'Меню опубликовано и закреплено.',ephemeral:true});}
  if(i.commandName==='status')return i.reply({embeds:[await statusEmbed()]});
  if(i.commandName==='stats')return myStats(i,i.options.getUser('user')?.id||i.user.id);
  if(i.commandName==='top')return top(i,i.options.getString('category'));
  if(i.commandName==='link'){const r=await api('/api/link/claim',{method:'POST',body:JSON.stringify({code:i.options.getString('code'),discordId:i.user.id})});return i.reply({content:`✅ Steam-профиль **${r.name}** привязан.`,ephemeral:true});}
  if(i.commandName==='idea'){const e=new EmbedBuilder().setColor(color).setTitle('💡 Идея').setDescription(i.options.getString('text')).addFields({name:'Создано',value:`<@${i.user.id}>`}).setFooter({text:`${brand} • Голосование`}).setTimestamp();await i.reply({embeds:[e],components:[ideaRow(0,0)]});const m=await i.fetchReply();votes.set(m.id,new Map());return;}
 }
 if(i.isButton()){
  if(i.customId==='br_status')return i.reply({embeds:[await statusEmbed()],ephemeral:true});
  if(i.customId==='br_stats')return myStats(i);
  if(i.customId==='br_top')return top(i,'score');
  if(i.customId==='br_link')return i.reply({content:'В игре введите `/link`, затем здесь `/link code:КОД`.',ephemeral:true});
  if(i.customId.startsWith('idea_')){const map=votes.get(i.message.id)||new Map(),choice=i.customId==='idea_up'?'up':'down';map.set(i.user.id,choice);votes.set(i.message.id,map);let up=0,down=0;for(const v of map.values())v==='up'?up++:down++;return i.update({components:[ideaRow(up,down)]});}
 }
}catch(e){console.error(e);const p={content:`Ошибка: ${e.message}`,ephemeral:true};if(i.replied||i.deferred)await i.followUp(p).catch(()=>null);else await i.reply(p).catch(()=>null);}});
client.login(process.env.DISCORD_TOKEN);

async function shutdown(signal){console.log(`${signal}: корректное завершение`);healthServer.close();client.destroy();process.exit(0);}
process.once('SIGTERM',()=>shutdown('SIGTERM'));
process.once('SIGINT',()=>shutdown('SIGINT'));
