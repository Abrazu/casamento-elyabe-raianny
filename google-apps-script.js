/**
 * ════════════════════════════════════════════════════════════════
 *  SITE DE CASAMENTO — Google Apps Script Backend
 *  Cole este código no painel do Google Apps Script.
 * ════════════════════════════════════════════════════════════════
 *
 *  INSTRUÇÕES DE CONFIGURAÇÃO
 *  ──────────────────────────
 *  1. Acesse sheets.google.com e crie uma nova planilha.
 *  2. No menu Extensões → Apps Script, substitua o código padrão
 *     pelo conteúdo deste arquivo e clique em Salvar (Ctrl+S).
 *  3. Clique em Implantar → Nova Implantação:
 *       Tipo:              App da Web
 *       Executar como:     Eu (seu e-mail do Google)
 *       Quem pode acessar: Qualquer pessoa
 *  4. Clique em Implantar e autorize as permissões solicitadas.
 *  5. Copie a URL gerada (termina em /exec) e cole como valor de
 *     API_URL em index.html e em painel-noivos.html.
 *
 *  As abas da planilha ('Presentes', 'RSVP', 'Configuracoes',
 *  'Historia') são criadas automaticamente na primeira gravação.
 *
 *  ESTRUTURA DE DADOS
 *  ──────────────────
 *  Cada aba armazena um único valor JSON na célula A2:
 *    Presentes     → Array   de objetos de presente (catálogo completo)
 *    RSVP          → Array   de confirmações de presença recebidas
 *    Configuracoes → Object  com nomes, data, senhas e cores do site
 *    Historia      → String  com o texto da seção "Nossa História"
 * ════════════════════════════════════════════════════════════════
 */

// ── Configuração ──────────────────────────────────────────────────────────────

/**
 * Deixe em branco para usar automaticamente a planilha à qual este
 * script está vinculado (recomendado).
 * Preencha apenas se quiser apontar para outra planilha pelo ID.
 */
const SPREADSHEET_ID = '';

/** Nomes de abas aceitos pela API. Qualquer outro será rejeitado. */
const ABAS_VALIDAS = ['Presentes', 'RSVP', 'Configuracoes', 'Historia'];

// ── Utilitários internos ──────────────────────────────────────────────────────

function getPlanilha_() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Retorna o objeto Sheet pelo nome.
 * Se a aba não existir, cria-a com o cabeçalho 'json' em A1.
 */
function getAba_(nome) {
  const ss    = getPlanilha_();
  let   sheet = ss.getSheetByName(nome);
  if (!sheet) {
    sheet = ss.insertSheet(nome);
    sheet.getRange('A1').setValue('json');
  }
  return sheet;
}

/**
 * Lê e faz parse do JSON armazenado na célula A2.
 * Retorna null se a célula estiver vazia ou se o JSON for inválido.
 */
function lerDados_(nome) {
  const valor = getAba_(nome).getRange('A2').getValue();
  if (!valor) return null;
  try   { return JSON.parse(valor); }
  catch { return null; }
}

/**
 * Serializa `dados` como JSON e grava na célula A2,
 * substituindo o conteúdo anterior.
 */
function gravarDados_(nome, dados) {
  const sheet = getAba_(nome);
  sheet.getRange('A1').setValue('json');
  sheet.getRange('A2').setValue(JSON.stringify(dados));
}

/**
 * Adiciona `novoItem` ao array armazenado em A2.
 * Usa LockService para evitar condição de corrida em envios simultâneos
 * (ex.: dois convidados confirmando presença ao mesmo tempo).
 */
function appendDados_(nome, novoItem) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000); // aguarda até 15 s para obter o lock
  try {
    const atual = lerDados_(nome);
    const arr   = Array.isArray(atual) ? atual : [];
    arr.push(novoItem);
    gravarDados_(nome, arr);
  } finally {
    lock.releaseLock();
  }
}

// ── Resposta JSON padronizada ─────────────────────────────────────────────────

function resposta_(payload, ehErro) {
  const corpo = ehErro
    ? JSON.stringify({ ok: false, erro:  payload })
    : JSON.stringify({ ok: true,  data:  payload });
  return ContentService
    .createTextOutput(corpo)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET ───────────────────────────────────────────────────────────────────────

/**
 * Trata leituras do site.
 *
 * Parâmetro de URL:
 *   ?sheet=NomeDaAba
 *   Ex: GET https://…/exec?sheet=Presentes
 *
 * Resposta de sucesso:  { ok: true,  data: <conteúdo da aba> }
 * Resposta de erro:     { ok: false, erro: "mensagem" }
 */
function doGet(e) {
  try {
    const nome = (e.parameter.sheet || '').trim();
    if (!ABAS_VALIDAS.includes(nome)) {
      return resposta_(
        'Parâmetro "sheet" inválido. Valores aceitos: ' + ABAS_VALIDAS.join(', '),
        true
      );
    }
    return resposta_(lerDados_(nome), false);
  } catch (err) {
    return resposta_('Erro interno no GET: ' + err.message, true);
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

/**
 * Trata gravações do painel e do site público.
 *
 * O corpo é enviado como application/x-www-form-urlencoded
 * (sem preflight CORS) com a chave "payload" contendo um JSON string.
 *
 * Formato do payload:
 *   {
 *     sheet: "NomeDaAba",          // obrigatório
 *     data:  <qualquer valor>,      // obrigatório
 *     modo:  "replace" | "append"  // opcional; padrão: "replace"
 *   }
 *
 * Modos:
 *   "replace" → grava `data` substituindo todo o conteúdo da célula A2
 *   "append"  → adiciona `data` ao array da célula A2 (thread-safe)
 *
 * Resposta de sucesso:  { ok: true,  data: "Salvo com sucesso." }
 * Resposta de erro:     { ok: false, erro: "mensagem" }
 */
function doPost(e) {
  try {
    const rawPayload = e.parameter.payload;
    if (!rawPayload) {
      return resposta_('Parâmetro "payload" ausente no corpo da requisição.', true);
    }

    const parsed = JSON.parse(rawPayload);
    const nome   = (parsed.sheet || '').trim();
    const data   = parsed.data;
    const modo   = parsed.modo || 'replace';

    if (!ABAS_VALIDAS.includes(nome)) {
      return resposta_(
        'Campo "sheet" inválido no payload. Valores aceitos: ' + ABAS_VALIDAS.join(', '),
        true
      );
    }

    if (modo === 'append') {
      appendDados_(nome, data);
    } else {
      gravarDados_(nome, data);
    }

    return resposta_('Salvo com sucesso.', false);

  } catch (err) {
    return resposta_('Erro interno no POST: ' + err.message, true);
  }
}
