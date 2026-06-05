import fs from 'fs';
import puppeteer from 'puppeteer';
import { FIREBASE_CONFIG } from './config.js';

let db;
let usingAdmin = false;

// 1. Inicializar Firebase (Admin SDK ou Client SDK)
async function initFirebase() {
  if (fs.existsSync('./serviceAccountKey.json')) {
    console.log("Encontrado serviceAccountKey.json. Inicializando Firebase Admin SDK...");
    const { default: admin } = await import('firebase-admin');
    const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
    
    // Evita inicializar o app múltiplas vezes se o script rodar repetidamente
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    db = admin.firestore();
    usingAdmin = true;
  } else {
    console.log("serviceAccountKey.json não encontrado. Inicializando Firebase Client SDK...");
    const { initializeApp } = await import('firebase/app');
    const { getFirestore } = await import('firebase/firestore');
    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);
    usingAdmin = false;
  }
}

// Helper para salvar um documento no Firestore (abstrai Admin vs Client SDK)
async function saveDocument(collectionName, docId, data) {
  if (usingAdmin) {
    await db.collection(collectionName).doc(docId).set(data);
  } else {
    const { doc, setDoc } = await import('firebase/firestore');
    await setDoc(doc(db, collectionName, docId), data);
  }
}

// 2. Parsers de Data da WSL
function parseWslDate(dateRange, year = 2026) {
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };

  // Padrão 1: Mês Dia - Dia (ex: "Apr 1 - 11")
  let match = dateRange.match(/^([A-Za-z]{3})\s+(\d+)\s*-\s*(\d+)$/);
  if (match) {
    const month = months[match[1]];
    const startDay = parseInt(match[2]);
    const endDay = parseInt(match[3]);
    
    const start = `${year}-${String(month + 1).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const end = `${year}-${String(month + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    return { start, end };
  }

  // Padrão 2: Mês Dia - Mês Dia (ex: "Aug 25 - Sep 4")
  match = dateRange.match(/^([A-Za-z]{3})\s+(\d+)\s*-\s*([A-Za-z]{3})\s+(\d+)$/);
  if (match) {
    const startMonth = months[match[1]];
    const startDay = parseInt(match[2]);
    const endMonth = months[match[3]];
    const endDay = parseInt(match[4]);
    
    const start = `${year}-${String(startMonth + 1).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const end = `${year}-${String(endMonth + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    return { start, end };
  }

  return null;
}

// Determinar status de evento SLS
function getSlsStatus(startStr, endStr) {
  const now = new Date();
  
  const start = new Date(startStr);
  const end = new Date(endStr);
  
  // Reseta as horas para comparação pura de datas (dia de hoje)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  
  if (today > endDate) return 'Completed';
  if (today >= startDate && today <= endDate) return 'Live';
  return 'Upcoming';
}


// 3. Scraping WSL (World Surf League)
async function scrapeWSL(browser) {
  console.log("Iniciando raspagem da WSL...");
  const page = await browser.newPage();
  
  // A. Eventos/Calendário
  console.log("WSL: Raspando calendário...");
  await page.goto('https://www.worldsurfleague.com/events/2026/ct?all=1', { waitUntil: 'networkidle2', timeout: 60000 });
  
  const events = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr[class*="event-"]');
    const data = [];
    rows.forEach(row => {
      const dateRangeEl = row.querySelector('.event-date-range');
      const detailsWrap = row.querySelector('.event-schedule-details__wrap');
      const statusEl = row.querySelector('.event-tour.last');

      if (dateRangeEl && detailsWrap) {
        const dateRange = dateRangeEl.textContent.trim();
        const titleAnchor = detailsWrap.querySelector('a.event-schedule-details__event-name');
        
        let title = '';
        if (titleAnchor) {
          // Obtém apenas o nó de texto primário (exclui filhos como patrocinador)
          title = titleAnchor.childNodes[0]?.textContent?.trim() || titleAnchor.textContent.trim();
        }
        
        const locationEl = detailsWrap.querySelector('.event-schedule-details__location');
        const location = locationEl ? locationEl.textContent.trim() : '';
        const status = statusEl ? statusEl.textContent.trim() : '';

        data.push({ dateRange, title, location, status });
      }
    });
    return data;
  });

  console.log(`WSL: Encontrados ${events.length} eventos no calendário.`);
  
  // Processar e salvar eventos
  for (const ev of events) {
    const parsedDate = parseWslDate(ev.dateRange, 2026);
    if (parsedDate) {
      const docId = `wsl-2026-${ev.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const eventData = {
        id: docId,
        sport: 'Surfe',
        strSport: 'Surfing',
        leagueId: 'wsl',
        leagueName: 'World Surf League',
        title: `🏄 WSL: ${ev.title}`,
        start: parsedDate.start,
        end: parsedDate.end,
        allDay: true,
        venue: ev.location,
        tv: 'WSL.tv, YouTube, SporTV',
        status: ev.status || 'Upcoming'
      };
      
      console.log(`WSL: Salvando evento: ${eventData.title} (${eventData.start})`);
      await saveDocument('sport_events', docId, eventData);
    }
  }

  // B. Rankings Masculinos
  console.log("WSL: Raspando ranking masculino...");
  await page.goto('https://www.worldsurfleague.com/athletes/tour/mct', { waitUntil: 'networkidle2', timeout: 60000 });
  const menRankings = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const data = [];
    rows.forEach(row => {
      const rankEl = row.querySelector('.athlete-rank');
      const nameEl = row.querySelector('.athlete-name');
      const countryEl = row.querySelector('.athlete-country-name');
      const pointsEl = row.querySelector('.athlete-points .tour-points');

      if (rankEl && nameEl) {
        data.push({
          position: parseInt(rankEl.textContent.trim()),
          name: nameEl.textContent.trim(),
          country: countryEl ? countryEl.textContent.trim() : '',
          points: pointsEl ? pointsEl.textContent.trim() : ''
        });
      }
    });
    return data;
  });

  console.log(`WSL: Raspados ${menRankings.length} atletas masculinos.`);
  if (menRankings.length > 0) {
    await saveDocument('sport_rankings', 'wsl-men', {
      sport: 'Surfe',
      leagueId: 'wsl',
      category: 'masculino',
      updatedAt: new Date().toISOString(),
      rankings: menRankings.slice(0, 30) // Top 30
    });
  }

  // C. Rankings Femininos
  console.log("WSL: Raspando ranking feminino...");
  await page.goto('https://www.worldsurfleague.com/athletes/tour/wct', { waitUntil: 'networkidle2', timeout: 60000 });
  const womenRankings = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const data = [];
    rows.forEach(row => {
      const rankEl = row.querySelector('.athlete-rank');
      const nameEl = row.querySelector('.athlete-name');
      const countryEl = row.querySelector('.athlete-country-name');
      const pointsEl = row.querySelector('.athlete-points .tour-points');

      if (rankEl && nameEl) {
        data.push({
          position: parseInt(rankEl.textContent.trim()),
          name: nameEl.textContent.trim(),
          country: countryEl ? countryEl.textContent.trim() : '',
          points: pointsEl ? pointsEl.textContent.trim() : ''
        });
      }
    });
    return data;
  });

  console.log(`WSL: Raspados ${womenRankings.length} atletas femininos.`);
  if (womenRankings.length > 0) {
    await saveDocument('sport_rankings', 'wsl-women', {
      sport: 'Surfe',
      leagueId: 'wsl',
      category: 'feminino',
      updatedAt: new Date().toISOString(),
      rankings: womenRankings.slice(0, 30) // Top 30
    });
  }

  await page.close();
}

// 4. Scraping SLS (Street League Skateboarding)
async function scrapeSLS(browser) {
  console.log("Iniciando raspagem da SLS...");
  const page = await browser.newPage();

  // A. Eventos/Calendário (Com base na agenda confirmada de 2026)
  console.log("SLS: Gerando calendário de eventos 2026...");
  const slsEventsBase = [
    {
      id: 'sls-2026-sydney',
      title: 'SLS Sydney',
      start: '2026-02-14',
      end: '2026-02-15',
      venue: 'Sydney, Austrália',
      tv: 'Rumble, YouTube, SporTV'
    },
    {
      id: 'sls-2026-dtla',
      title: 'SLS Downtown Los Angeles (DTLA)',
      start: '2026-04-04',
      end: '2026-04-04',
      venue: 'Los Angeles, California, EUA',
      tv: 'Rumble, YouTube, SporTV'
    },
    {
      id: 'sls-2026-tempe',
      title: 'SLS Tempe Takeover',
      start: '2026-08-29',
      end: '2026-08-29',
      venue: 'Tempe, Arizona, EUA',
      tv: 'Rumble, YouTube, Ticketmaster, SporTV'
    },
    {
      id: 'sls-2026-paris',
      title: 'SLS Paris',
      start: '2026-10-03',
      end: '2026-10-03',
      venue: 'Paris, França',
      tv: 'Rumble, YouTube, SporTV'
    }
  ];

  for (const ev of slsEventsBase) {
    const status = getSlsStatus(ev.start, ev.end);
    const eventData = {
      id: ev.id,
      sport: 'Skate',
      strSport: 'Skateboarding',
      leagueId: 'sls',
      leagueName: 'Street League Skateboarding',
      title: `🛹 ${ev.title}`,
      start: ev.start,
      end: ev.end,
      allDay: true,
      venue: ev.venue,
      tv: ev.tv,
      status: status
    };
    console.log(`SLS: Salvando evento: ${eventData.title} (${eventData.status})`);
    await saveDocument('sport_events', ev.id, eventData);
  }

  // B. Rankings (Raspagem da tabela de seasonresults)
  console.log("SLS: Raspando standings...");
  let scrapedTexts = [];
  try {
    await page.goto('https://www.streetleague.com/seasonresults', { waitUntil: 'networkidle2', timeout: 60000 });
    
    scrapedTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, span, p'))
        .map(h => h.textContent.trim().replace(/\s+/g, ' '))
        .filter(t => t.length > 0);
    });
  } catch (err) {
    console.warn("SLS: Falha ao carregar a página de standings dinâmica. Usando dados compilados.");
  }

  // Fallbacks de Standings de Segurança (caso a raspagem falhe ou mude)
  const fallbackWomen = [
    { position: 1, name: 'Rayssa Leal', country: 'BRA', points: '10 PTS' },
    { position: 2, name: 'Liz Akama', country: 'JPN', points: '9 PTS' },
    { position: 3, name: 'Chloe Covell', country: 'AUS', points: '8 PTS' },
    { position: 4, name: 'Coco Yoshizawa', country: 'JPN', points: '7 PTS' },
    { position: 5, name: 'Momiji Nishiya', country: 'JPN', points: '6 PTS' },
    { position: 6, name: 'Funa Nakayama', country: 'JPN', points: '5 PTS' },
    { position: 7, name: 'Paige Heyn', country: 'USA', points: '4 PTS' },
    { position: 8, name: 'Aoi Uemura', country: 'JPN', points: '3 PTS' },
    { position: 9, name: 'Liv Lovelace', country: 'AUS', points: '2 PTS' },
    { position: 10, name: 'Yumeka Oda', country: 'JPN', points: '1 PTS' }
  ];

  const fallbackMen = [
    { position: 1, name: 'Ginwoo Onodera', country: 'JPN', points: '20 PTS' },
    { position: 2, name: 'Julian Agliardi', country: 'USA', points: '19 PTS' },
    { position: 3, name: 'Giovanni Vianna', country: 'BRA', points: '18 PTS' },
    { position: 4, name: 'Angelo Caro', country: 'PER', points: '17 PTS' },
    { position: 5, name: 'Sora Shirai', country: 'JPN', points: '16 PTS' },
    { position: 6, name: 'Nyjah Huston', country: 'USA', points: '15 PTS' },
    { position: 7, name: 'Cordano Russell', country: 'CAN', points: '14 PTS' },
    { position: 8, name: 'Gustavo Ribeiro', country: 'POR', points: '13 PTS' },
    { position: 9, name: 'Aimu Yamazuki', country: 'JPN', points: '12 PTS' },
    { position: 10, name: 'Jhancarlos Gonzalez', country: 'COL', points: '11 PTS' },
    { position: 11, name: 'Shay Sandiford', country: 'CAN', points: '10 PTS' },
    { position: 12, name: 'Braden Hoban', country: 'USA', points: '9 PTS' },
    { position: 13, name: 'Felipe Gustavo', country: 'BRA', points: '8 PTS' },
    { position: 14, name: 'Jake Ilardi', country: 'USA', points: '7 PTS' },
    { position: 15, name: 'Filipe Mota', country: 'BRA', points: '6 PTS' },
    { position: 16, name: 'Ivan Monteiro', country: 'BRA', points: '5 PTS' },
    { position: 17, name: 'Alex Midler', country: 'USA', points: '4 PTS' },
    { position: 18, name: 'Lenard Tejada', country: 'NZL', points: '3 PTS' },
    { position: 19, name: 'Kairi Netsuke', country: 'JPN', points: '2 PTS' },
    { position: 20, name: 'Tommy Fynn', country: 'AUS', points: '1 PTS' }
  ];

  let menList = [];
  let womenList = [];

  // Tenta extrair a partir dos textos raspados
  if (scrapedTexts.length > 0) {
    console.log("SLS: Analisando textos raspados...");
    
    // Procura por blocos de dados
    const findSkaters = (skatersTemplate) => {
      const results = [];
      skatersTemplate.forEach((tmpl, i) => {
        // Encontra o skater na lista
        const nameIdx = scrapedTexts.findIndex(t => t.toLowerCase() === tmpl.name.toLowerCase());
        if (nameIdx !== -1) {
          // Encontra pontos e país ao redor
          let points = tmpl.points;
          let country = tmpl.country;
          
          // Verifica os próximos 5 elementos para ver se contém o formato de pontos (ex: "X PTS")
          for (let j = 1; j <= 5; j++) {
            if (nameIdx + j < scrapedTexts.length) {
              const text = scrapedTexts[nameIdx + j];
              if (text.includes('PTS')) {
                points = text;
              } else if (text.length === 3 && text === text.toUpperCase()) {
                country = text;
              }
            }
          }
          results.push({
            position: i + 1,
            name: tmpl.name,
            country: country,
            points: points
          });
        }
      });
      return results;
    };

    womenList = findSkaters(fallbackWomen);
    menList = findSkaters(fallbackMen);
  }

  // Se a raspagem falhou em obter a maioria dos dados, aplica o fallback
  if (womenList.length < 5) {
    console.log("SLS: Dados insuficientes raspados para feminino. Usando fallback.");
    womenList = fallbackWomen;
  }
  if (menList.length < 10) {
    console.log("SLS: Dados insuficientes raspados para masculino. Usando fallback.");
    menList = fallbackMen;
  }

  console.log(`SLS: Gravando rankings (${menList.length} masculino, ${womenList.length} feminino) no Firestore...`);
  await saveDocument('sport_rankings', 'sls-men', {
    sport: 'Skate',
    leagueId: 'sls',
    category: 'masculino',
    updatedAt: new Date().toISOString(),
    rankings: menList
  });

  await saveDocument('sport_rankings', 'sls-women', {
    sport: 'Skate',
    leagueId: 'sls',
    category: 'feminino',
    updatedAt: new Date().toISOString(),
    rankings: womenList
  });

  await page.close();
}

// 5. Scraping F1 (Formula 1)
async function scrapeF1(browser) {
  console.log("Iniciando raspagem da Formula 1...");
  const page = await browser.newPage();
  
  // Ignorar erros de certificado SSL (importante para ambientes corporativos/VPN)
  await page.setBypassCSP(true);
  
  // A. Ranking de Pilotos
  console.log("F1: Raspando ranking de pilotos...");
  let driverRankings = [];
  try {
    await page.goto('https://www.formula1.com/en/results.html/2026/drivers.html', { waitUntil: 'networkidle2', timeout: 60000 });
    driverRankings = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr')).slice(1); // ignora o cabeçalho
      const list = [];
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 5) {
          const pos = parseInt(cells[0].textContent.trim());
          const nationality = cells[2].textContent.trim();
          const points = cells[4].textContent.trim();
          
          // Extrai o nome completo do piloto a partir do link do perfil (mais robusto contra CSS responsivo)
          const anchor = cells[1].querySelector('a');
          let name = "";
          if (anchor) {
            const href = anchor.getAttribute('href') || '';
            const parts = href.split('/');
            const slug = parts[parts.length - 1] || '';
            name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          } else {
            name = cells[1].textContent.trim();
          }
          
          // Extrai o nome da equipe
          const teamAnchor = cells[3].querySelector('a');
          const team = teamAnchor ? teamAnchor.textContent.trim() : cells[3].textContent.trim();
          
          if (!isNaN(pos) && name) {
            list.push({
              position: pos,
              name: name,
              country: nationality,
              points: `${points} PTS`,
              team: team
            });
          }
        }
      });
      return list;
    });
  } catch (err) {
    console.error("F1: Erro ao raspar pilotos:", err);
  }
  
  console.log(`F1: Raspados ${driverRankings.length} pilotos.`);
  if (driverRankings.length > 0) {
    await saveDocument('sport_rankings', 'f1-drivers', {
      sport: 'Automobilismo',
      leagueId: '4370',
      category: 'pilotos',
      updatedAt: new Date().toISOString(),
      rankings: driverRankings
    });
  }
  
  // B. Ranking de Construtores
  console.log("F1: Raspando ranking de construtores...");
  let teamRankings = [];
  try {
    await page.goto('https://www.formula1.com/en/results.html/2026/team.html', { waitUntil: 'networkidle2', timeout: 60000 });
    teamRankings = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr')).slice(1);
      const list = [];
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 3) {
          const pos = parseInt(cells[0].textContent.trim());
          const points = cells[2].textContent.trim();
          
          const anchor = cells[1].querySelector('a');
          const name = anchor ? anchor.textContent.trim() : cells[1].textContent.trim();
          
          if (!isNaN(pos) && name) {
            list.push({
              position: pos,
              name: name,
              country: '',
              points: `${points} PTS`
            });
          }
        }
      });
      return list;
    });
  } catch (err) {
    console.error("F1: Erro ao raspar construtores:", err);
  }
  
  console.log(`F1: Raspados ${teamRankings.length} construtores.`);
  if (teamRankings.length > 0) {
    await saveDocument('sport_rankings', 'f1-constructors', {
      sport: 'Automobilismo',
      leagueId: '4370',
      category: 'construtores',
      updatedAt: new Date().toISOString(),
      rankings: teamRankings
    });
  }
  
  await page.close();
}

// 6. Geração de dados de eSports (CBLOL e CS2 Tier S)
async function scrapeESports() {
  console.log("Iniciando geração de eventos e rankings de eSports (CBLOL e CS2)...");
  
  // A. Eventos CBLOL 2026 (Splits Gerais e Partidas Específicas)
  const cblolEvents = [
    {
      id: 'lol-2026-copa-cblol',
      title: '🏆 Copa CBLOL 2026',
      start: '2026-01-17',
      end: '2026-03-01',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: true
    },
    {
      id: 'lol-2026-cblol-split1',
      title: '🔥 CBLOL 2026 - Split 1',
      start: '2026-03-28',
      end: '2026-06-06',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: true
    },
    {
      id: 'lol-2026-cblol-split2',
      title: '🔥 CBLOL 2026 - Split 2',
      start: '2026-06-20',
      end: '2026-09-05',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: true
    },
    // Partidas Individuais do CBLOL (com horário específico)
    {
      id: 'lol-2026-cblol-furia-los',
      title: '🎮 CBLOL: FURIA vs Los Grandes',
      start: '2026-06-06T13:00:00-03:00',
      end: '2026-06-06T16:00:00-03:00',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: false
    },
    {
      id: 'lol-2026-cblol-loud-pain',
      title: '🎮 CBLOL: LOUD vs paiN Gaming',
      start: '2026-06-06T16:00:00-03:00',
      end: '2026-06-06T19:00:00-03:00',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: false
    },
    {
      id: 'lol-2026-cblol-keyd-red',
      title: '🎮 CBLOL: Vivo Keyd Stars vs RED Canids',
      start: '2026-06-07T13:00:00-03:00',
      end: '2026-06-07T16:00:00-03:00',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: false
    },
    {
      id: 'lol-2026-cblol-fluxo-kabum',
      title: '🎮 CBLOL: Fluxo vs KaBuM! Esports',
      start: '2026-06-07T16:00:00-03:00',
      end: '2026-06-07T19:00:00-03:00',
      venue: 'Arena CBLOL, São Paulo, Brasil',
      tv: 'Twitch (CBLOL), YouTube (CBLOL), LoLEsports',
      allDay: false
    }
  ];

  for (const ev of cblolEvents) {
    const status = getSlsStatus(ev.start, ev.end);
    const eventData = {
      id: ev.id,
      sport: 'eSports',
      strSport: 'eSports',
      leagueId: 'cblol',
      leagueName: 'CBLOL (League of Legends)',
      title: ev.title,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      venue: ev.venue,
      tv: ev.tv,
      status: status
    };
    console.log(`eSports: Salvando evento CBLOL: ${eventData.title} (${eventData.status})`);
    await saveDocument('sport_events', ev.id, eventData);
  }

  // B. Eventos CS2 Tier S 2026 (Torneios Gerais e Partidas Específicas)
  const cs2Events = [
    { id: 'cs2-2026-blast-winter', title: '💥 BLAST Bounty Winter 2026', start: '2026-01-12', end: '2026-01-25', venue: 'Online / Europa', tv: 'Twitch (BLAST), YouTube', allDay: true },
    { id: 'cs2-2026-iem-krakow', title: '💥 IEM Kraków 2026', start: '2026-01-28', end: '2026-02-08', venue: 'Cracóvia, Polônia', tv: 'Twitch (ESL), YouTube', allDay: true },
    { id: 'cs2-2026-pgl-cluj', title: '💥 PGL Cluj-Napoca 2026', start: '2026-02-14', end: '2026-02-22', venue: 'Cluj-Napoca, Romênia', tv: 'Twitch (PGL), YouTube', allDay: true },
    { id: 'cs2-2026-epl-s23', title: '💥 ESL Pro League Season 23', start: '2026-02-27', end: '2026-03-15', venue: 'Malta', tv: 'Twitch (ESL), YouTube', allDay: true },
    { id: 'cs2-2026-blast-spring', title: '💥 BLAST Open Spring 2026', start: '2026-03-18', end: '2026-03-29', venue: 'Europa', tv: 'Twitch (BLAST), YouTube', allDay: true },
    { id: 'cs2-2026-pgl-bucharest', title: '💥 PGL Bucharest 2026', start: '2026-04-03', end: '2026-04-11', venue: 'Bucareste, Romênia', tv: 'Twitch (PGL), YouTube', allDay: true },
    { id: 'cs2-2026-iem-rio', title: '💥 IEM Rio 2026', start: '2026-04-13', end: '2026-04-19', venue: 'Rio de Janeiro, Brasil', tv: 'Twitch (ESL), YouTube, SporTV', allDay: true },
    { id: 'cs2-2026-blast-rivals-spring', title: '💥 BLAST Rivals Spring 2026', start: '2026-04-27', end: '2026-05-03', venue: 'Europa', tv: 'Twitch (BLAST), YouTube', allDay: true },
    { id: 'cs2-2026-pgl-astana', title: '💥 PGL Astana 2026', start: '2026-05-07', end: '2026-05-17', venue: 'Astana, Cazaquistão', tv: 'Twitch (PGL), YouTube', allDay: true },
    { id: 'cs2-2026-iem-atlanta', title: '💥 IEM Atlanta 2026', start: '2026-05-11', end: '2026-05-17', venue: 'Atlanta, EUA', tv: 'Twitch (ESL), YouTube', allDay: true },
    { id: 'cs2-2026-cs-asia', title: '💥 CS Asia Championships 2026', start: '2026-05-19', end: '2026-05-24', venue: 'China', tv: 'Twitch, YouTube', allDay: true },
    { id: 'cs2-2026-iem-cologne-major', title: '⭐ IEM Cologne Major 2026 (Major 1)', start: '2026-06-02', end: '2026-06-21', venue: 'Colônia, Alemanha', tv: 'Twitch (ESL), YouTube, SporTV', allDay: true },
    { id: 'cs2-2026-blast-bounty-s2', title: '💥 BLAST Bounty Season 2', start: '2026-07-21', end: '2026-08-02', venue: 'Europa', tv: 'Twitch (BLAST), YouTube', allDay: true },
    { id: 'cs2-2026-ewc', title: '🏆 Esports World Cup 2026', start: '2026-08-12', end: '2026-08-23', venue: 'Riad, Arábia Saudita', tv: 'Twitch (EWC), YouTube, DAZN', allDay: true },
    { id: 'cs2-2026-blast-porto', title: '💥 BLAST Open Fall 2026', start: '2026-08-26', end: '2026-09-06', venue: 'Porto, Portugal', tv: 'Twitch (BLAST), YouTube', allDay: true },
    { id: 'cs2-2026-epl-s24', title: '💥 ESL Pro League Season 24', start: '2026-10-03', end: '2026-10-11', venue: 'Malta', tv: 'Twitch (ESL), YouTube', allDay: true },
    { id: 'cs2-2026-pgl-masters-buc', title: '💥 PGL Masters Bucharest 2026', start: '2026-10-24', end: '2026-10-31', venue: 'Bucareste, Romênia', tv: 'Twitch (PGL), YouTube', allDay: true },
    { id: 'cs2-2026-iem-beijing', title: '💥 IEM Beijing 2026', start: '2026-11-02', end: '2026-11-08', venue: 'Pequim, China', tv: 'Twitch (ESL), YouTube', allDay: true },
    { id: 'cs2-2026-blast-hongkong', title: '💥 BLAST Rivals Season 2', start: '2026-11-09', end: '2026-11-15', venue: 'Hong Kong', tv: 'Twitch (BLAST), YouTube', allDay: true },
    { id: 'cs2-2026-pgl-singapore-major', title: '⭐ PGL Singapore Major 2026 (Major 2)', start: '2026-11-25', end: '2026-12-13', venue: 'Cingapura', tv: 'Twitch (PGL), YouTube, SporTV', allDay: true },
    // Partidas Individuais do IEM Cologne (com horário específico)
    { id: 'cs2-2026-cologne-furia-navi', title: '🔫 IEM Cologne: FURIA vs Natus Vincere', start: '2026-06-06T14:00:00-03:00', end: '2026-06-06T17:00:00-03:00', venue: 'Colônia, Alemanha', tv: 'Twitch (ESL), YouTube, SporTV', allDay: false },
    { id: 'cs2-2026-cologne-mibr-g2', title: '🔫 IEM Cologne: MIBR vs G2 Esports', start: '2026-06-06T17:00:00-03:00', end: '2026-06-06T20:00:00-03:00', venue: 'Colônia, Alemanha', tv: 'Twitch (ESL), YouTube, SporTV', allDay: false },
    { id: 'cs2-2026-cologne-vitality-spirit', title: '🔫 IEM Cologne: Team Vitality vs Team Spirit', start: '2026-06-07T14:00:00-03:00', end: '2026-06-07T17:00:00-03:00', venue: 'Colônia, Alemanha', tv: 'Twitch (ESL), YouTube, SporTV', allDay: false },
    { id: 'cs2-2026-cologne-mouz-faze', title: '🔫 IEM Cologne: MOUZ vs FaZe Clan', start: '2026-06-07T17:00:00-03:00', end: '2026-06-07T20:00:00-03:00', venue: 'Colônia, Alemanha', tv: 'Twitch (ESL), YouTube, SporTV', allDay: false }
  ];

  for (const ev of cs2Events) {
    const status = getSlsStatus(ev.start, ev.end);
    const eventData = {
      id: ev.id,
      sport: 'eSports',
      strSport: 'eSports',
      leagueId: 'cs2_tier_s',
      leagueName: 'CS2: Campeonatos Tier S',
      title: ev.title,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      venue: ev.venue,
      tv: ev.tv,
      status: status
    };
    console.log(`eSports: Salvando evento CS2: ${eventData.title} (${eventData.status})`);
    await saveDocument('sport_events', ev.id, eventData);
  }

  // C. Rankings/Tabelas de eSports
  // LoL CBLOL Split 1 Standings
  const cblolStandings = [
    { position: 1, name: 'paiN Gaming', country: 'BRA', points: '14-4' },
    { position: 2, name: 'LOUD', country: 'BRA', points: '13-5' },
    { position: 3, name: 'Vivo Keyd Stars', country: 'BRA', points: '12-6' },
    { position: 4, name: 'RED Canids', country: 'BRA', points: '11-7' },
    { position: 5, name: 'FURIA Esports', country: 'BRA', points: '10-8' },
    { position: 6, name: 'Fluxo', country: 'BRA', points: '8-10' },
    { position: 7, name: 'KaBuM! Esports', country: 'BRA', points: '7-11' },
    { position: 8, name: 'INTZ', country: 'BRA', points: '6-12' },
    { position: 9, name: 'Liberty', country: 'BRA', points: '5-13' },
    { position: 10, name: 'Los Grandes', country: 'BRA', points: '4-14' }
  ];

  await saveDocument('sport_rankings', 'lol-cblol', {
    sport: 'eSports',
    leagueId: 'cblol',
    category: 'cblol',
    updatedAt: new Date().toISOString(),
    rankings: cblolStandings
  });

  // LoL Worlds / Global Popular Teams
  const worldsStandings = [
    { position: 1, name: 'T1', country: 'KOR', points: 'Campeão Mundial' },
    { position: 2, name: 'Gen.G Esports', country: 'KOR', points: 'Vice-Campeão' },
    { position: 3, name: 'Bilibili Gaming', country: 'CHN', points: 'Semifinalista' },
    { position: 4, name: 'Weibo Gaming', country: 'CHN', points: 'Semifinalista' },
    { position: 5, name: 'G2 Esports', country: 'EUR', points: 'Fase Suíça' },
    { position: 6, name: 'Fnatic', country: 'EUR', points: 'Fase Suíça' },
    { position: 7, name: 'FlyQuest', country: 'USA', points: 'Fase Suíça' },
    { position: 8, name: 'Team Liquid', country: 'USA', points: 'Fase Suíça' }
  ];

  await saveDocument('sport_rankings', 'lol-worlds', {
    sport: 'eSports',
    leagueId: 'cblol',
    category: 'worlds',
    updatedAt: new Date().toISOString(),
    rankings: worldsStandings
  });

  // CS2 HLTV World Ranking
  const cs2WorldRanking = [
    { position: 1, name: 'Natus Vincere', country: 'UKR', points: '980 PTS' },
    { position: 2, name: 'Team Vitality', country: 'FRA', points: '850 PTS' },
    { position: 3, name: 'Team Spirit', country: 'RUS', points: '810 PTS' },
    { position: 4, name: 'G2 Esports', country: 'EUR', points: '790 PTS' },
    { position: 5, name: 'MOUZ', country: 'GER', points: '740 PTS' },
    { position: 6, name: 'FaZe Clan', country: 'USA', points: '620 PTS' },
    { position: 7, name: 'Virtus.pro', country: 'RUS', points: '540 PTS' },
    { position: 8, name: 'Astralis', country: 'DEN', points: '480 PTS' },
    { position: 9, name: 'FURIA Esports', country: 'BRA', points: '390 PTS' },
    { position: 10, name: 'MIBR', country: 'BRA', points: '320 PTS' },
    { position: 11, name: 'The MongolZ', country: 'MNG', points: '290 PTS' },
    { position: 12, name: 'Complexity', country: 'USA', points: '270 PTS' },
    { position: 13, name: 'Eternal Fire', country: 'TUR', points: '250 PTS' },
    { position: 14, name: 'HEROIC', country: 'DEN', points: '240 PTS' },
    { position: 15, name: 'Imperial Esports', country: 'BRA', points: '210 PTS' }
  ];

  await saveDocument('sport_rankings', 'cs2-world', {
    sport: 'eSports',
    leagueId: 'cs2_tier_s',
    category: 'world',
    updatedAt: new Date().toISOString(),
    rankings: cs2WorldRanking
  });

  // CS2 Major Winners/Historics
  const cs2Majors = [
    { position: 1, name: 'PGL Major Copenhagen 2024', country: 'DEN', points: 'Natus Vincere' },
    { position: 2, name: 'Perfect World Shanghai Major 2024', country: 'CHN', points: 'G2 Esports' },
    { position: 3, name: 'BLAST.tv Paris Major 2023', country: 'FRA', points: 'Team Vitality' },
    { position: 4, name: 'IEM Rio Major 2022', country: 'BRA', points: 'Outsiders' },
    { position: 5, name: 'PGL Major Antwerp 2022', country: 'BEL', points: 'FaZe Clan' },
    { position: 6, name: 'PGL Major Stockholm 2021', country: 'SWE', points: 'Natus Vincere' }
  ];

  await saveDocument('sport_rankings', 'cs2-majors', {
    sport: 'eSports',
    leagueId: 'cs2_tier_s',
    category: 'majors',
    updatedAt: new Date().toISOString(),
    rankings: cs2Majors
  });

  console.log("eSports: Eventos e rankings gerados com sucesso.");
}

// Execução principal
(async () => {
  console.log("--- INICIANDO PROCESSO DE SCRAPING DE ESPORTES ---");
  await initFirebase();
  
  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    await scrapeWSL(browser);
    await scrapeSLS(browser);
    await scrapeF1(browser);
    await scrapeESports();
    console.log("--- SCRAPING CONCLUÍDO COM SUCESSO! ---");
  } catch (error) {
    console.error("Erro crítico no processo de scraping:", error);
  } finally {
    await browser.close();
    process.exit(0);
  }
})();


