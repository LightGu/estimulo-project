-- Permite after_trilha_id nulo em trilha_perfil_desvios: representa um "desvio
-- inicial" (para o setor, comece por trilha_destino_id em vez da 1a trilha da
-- sequencia do perfil), em vez de sempre trocar o que vem DEPOIS de uma trilha
-- existente. Sem isso, a 1a trilha entregue era sempre a mesma para todos os
-- setores de um perfil, sem excecao.
ALTER TABLE public.trilha_perfil_desvios
    ALTER COLUMN after_trilha_id DROP NOT NULL;

-- idx_trilha_perfil_desvios_anchor (profile_id, after_trilha_id) ja cobre buscas
-- com after_trilha_id IS NULL sem precisar de indice parcial dedicado.
