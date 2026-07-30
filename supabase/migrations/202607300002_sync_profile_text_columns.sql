CREATE OR REPLACE FUNCTION public.sync_trilha_perfis_perfil_text()
RETURNS trigger AS $$
BEGIN
    IF NEW.profile_id IS NOT NULL THEN
        SELECT nome INTO NEW.perfil FROM public.group_profiles WHERE id = NEW.profile_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_trilha_perfis_perfil_text ON public.trilha_perfis;
CREATE TRIGGER trg_sync_trilha_perfis_perfil_text
    BEFORE INSERT OR UPDATE OF profile_id ON public.trilha_perfis
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_trilha_perfis_perfil_text();

CREATE OR REPLACE FUNCTION public.sync_groups_segmento_text()
RETURNS trigger AS $$
BEGIN
    IF NEW.profile_id IS NOT NULL THEN
        SELECT nome INTO NEW.segmento FROM public.group_profiles WHERE id = NEW.profile_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_groups_segmento_text ON public.groups;
CREATE TRIGGER trg_sync_groups_segmento_text
    BEFORE INSERT OR UPDATE OF profile_id ON public.groups
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_groups_segmento_text();

CREATE OR REPLACE FUNCTION public.sync_profile_rename()
RETURNS trigger AS $$
BEGIN
    IF NEW.nome IS DISTINCT FROM OLD.nome THEN
        UPDATE public.trilha_perfis SET perfil = NEW.nome WHERE profile_id = NEW.id;
        UPDATE public.groups SET segmento = NEW.nome WHERE profile_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_profile_rename ON public.group_profiles;
CREATE TRIGGER trg_sync_profile_rename
    AFTER UPDATE OF nome ON public.group_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_profile_rename();
