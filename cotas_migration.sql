-- ══════════════════════════════════════════════════════════════
--  MIGRAÇÃO: Cotas / Financiamento Coletivo — Lista de Presentes
--  Execute este script no SQL Editor do Supabase.
-- ══════════════════════════════════════════════════════════════

-- 1. Novas colunas na tabela presentes
ALTER TABLE presentes
  ADD COLUMN IF NOT EXISTS valor_total NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS permite_cotas BOOLEAN DEFAULT FALSE;

-- 2. Nova tabela cotas_presentes
CREATE TABLE IF NOT EXISTS cotas_presentes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  presente_id   BIGINT NOT NULL REFERENCES presentes(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  whatsapp      TEXT DEFAULT '',
  valor         NUMERIC NOT NULL CHECK (valor >= 10),
  data          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cotas_presente_id ON cotas_presentes(presente_id);

-- 3. Políticas RLS para cotas_presentes
ALTER TABLE cotas_presentes ENABLE ROW LEVEL SECURITY;

-- Público pode ler (necessário para calcular barra de progresso)
CREATE POLICY "Permitir leitura pública das cotas"
  ON cotas_presentes FOR SELECT
  TO anon
  USING (true);

-- Público pode inserir contribuições
CREATE POLICY "Permitir inserção pública de cotas"
  ON cotas_presentes FOR INSERT
  TO anon
  WITH CHECK (true);

-- Admin autenticado pode fazer tudo (gerenciar/deletar)
CREATE POLICY "Admin acesso total às cotas"
  ON cotas_presentes FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 4. Função RPC contribuir_cota (atômica, previne race conditions)
CREATE OR REPLACE FUNCTION contribuir_cota(
  p_presente_id BIGINT,
  p_nome TEXT,
  p_whatsapp TEXT,
  p_valor NUMERIC
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_valor_total NUMERIC;
  v_permite BOOLEAN;
  v_arrecadado NUMERIC;
  v_restante NUMERIC;
BEGIN
  -- Buscar dados do presente com lock para evitar race condition
  SELECT valor_total, permite_cotas
    INTO v_valor_total, v_permite
    FROM presentes
    WHERE id = p_presente_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Presente não encontrado.');
  END IF;

  IF v_permite IS NOT TRUE THEN
    RETURN json_build_object('ok', false, 'erro', 'Este presente não aceita cotas.');
  END IF;

  -- Calcular total já arrecadado
  SELECT COALESCE(SUM(valor), 0)
    INTO v_arrecadado
    FROM cotas_presentes
    WHERE presente_id = p_presente_id;

  v_restante := v_valor_total - v_arrecadado;

  IF v_restante <= 0 THEN
    RETURN json_build_object('ok', false, 'erro', 'Este presente já foi totalmente financiado!');
  END IF;

  IF p_valor < 10 THEN
    RETURN json_build_object('ok', false, 'erro', 'Valor mínimo: R$ 10,00.');
  END IF;

  -- Inserir a cota (permite exceder na última contribuição)
  INSERT INTO cotas_presentes (presente_id, nome, whatsapp, valor)
    VALUES (p_presente_id, p_nome, p_whatsapp, p_valor);

  -- Atualizar total arrecadado
  v_arrecadado := v_arrecadado + p_valor;

  -- Se atingiu ou excedeu 100%, marca como financiado e bloqueia
  IF v_arrecadado >= v_valor_total THEN
    UPDATE presentes
      SET reservado_por = '⭐ Financiamento Coletivo',
          whats_reserva = '',
          data_reserva = TO_CHAR(NOW() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS')
      WHERE id = p_presente_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'arrecadado', v_arrecadado,
    'valor_total', v_valor_total,
    'percentual', ROUND((v_arrecadado / v_valor_total) * 100, 1),
    'completo', v_arrecadado >= v_valor_total
  );
END;
$$;
