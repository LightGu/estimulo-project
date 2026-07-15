const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { validateSupabaseEnv } = require("../src/config/supabase");

async function main() {
  const { supabaseUrl, supabaseServiceRoleKey } = validateSupabaseEnv();
  const client = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const organizationName = "Organizacao Seed";
  const groupNames = ["Grupo Alpha", "Grupo Beta", "Grupo Gama"];
  const campaignNames = ["Campanha Primaria", "Campanha Secundaria"];

  const { data: existingOrganization, error: orgError } = await client
    .from("organizations")
    .select("id")
    .eq("nome", organizationName)
    .maybeSingle();

  if (orgError) {
    throw orgError;
  }

  let organizationId = existingOrganization?.id;

  if (!organizationId) {
    const { data, error } = await client
      .from("organizations")
      .insert({ nome: organizationName })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    organizationId = data.id;
  }

  const groups = [];
  for (const groupName of groupNames) {
    const evolutionGroupId = `${groupName.toLowerCase().replace(/\s+/g, "-")}-seed`;
    const { data: existingGroup, error: groupLookupError } = await client
      .from("groups")
      .select("id")
      .eq("evolution_group_id", evolutionGroupId)
      .maybeSingle();

    if (groupLookupError) {
      throw groupLookupError;
    }

    if (existingGroup?.id) {
      groups.push(existingGroup);
      continue;
    }

    const { data, error } = await client
      .from("groups")
      .insert({
        organization_id: organizationId,
        nome: groupName,
        evolution_group_id: evolutionGroupId,
        segmento: "Pré",
        maturidade: 2,
        envia_video: true,
      })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    groups.push(data);
  }

  const campaigns = [];
  for (const campaignName of campaignNames) {
    const cronExpression = campaignName.includes("Secundaria") ? "0 9 * * *" : "0 8 * * *";
    const { data: existingCampaign, error: campaignLookupError } = await client
      .from("campaigns")
      .select("id")
      .eq("nome", campaignName)
      .maybeSingle();

    if (campaignLookupError) {
      throw campaignLookupError;
    }

    if (existingCampaign?.id) {
      campaigns.push(existingCampaign);
      continue;
    }

    const { data, error } = await client
      .from("campaigns")
      .insert({
        organization_id: organizationId,
        nome: campaignName,
        cron_expression: cronExpression,
        ativo: true,
      })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    campaigns.push(data);
  }

  for (const campaign of campaigns) {
    for (const group of groups) {
      const { error } = await client
        .from("campaign_groups")
        .upsert({ campaign_id: campaign.id, group_id: group.id }, { onConflict: "campaign_id,group_id" });

      if (error) {
        throw error;
      }
    }
  }

  const videos = [];
  for (let index = 1; index <= 10; index += 1) {
    const driveFileId = `seed-${index}`;
    const { data: existingVideo, error: videoLookupError } = await client
      .from("video_catalog")
      .select("id")
      .eq("drive_file_id", driveFileId)
      .maybeSingle();

    if (videoLookupError) {
      throw videoLookupError;
    }

    if (existingVideo?.id) {
      videos.push(existingVideo);
      continue;
    }

    const { data, error } = await client
      .from("video_catalog")
      .insert({
        drive_file_id: driveFileId,
        etapa: index <= 5 ? 1 : 2,
        trilha_segmento: "Pré",
        genero_conteudo: `Genero ${index}`,
        status: index % 3 === 0 ? "reprovado" : "aprovado",
        data_aprovacao: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    videos.push(data);
  }

  for (const [index, group] of groups.entries()) {
    const video = videos[index % videos.length];
    const { data: existingProgress, error: progressLookupError } = await client
      .from("group_video_progress")
      .select("id")
      .eq("group_id", group.id)
      .eq("video_id", video.id)
      .maybeSingle();

    if (progressLookupError) {
      throw progressLookupError;
    }

    if (!existingProgress?.id) {
      const { error } = await client
        .from("group_video_progress")
        .insert({ group_id: group.id, video_id: video.id });

      if (error) {
        throw error;
      }
    }
  }

  for (const [index, group] of groups.entries()) {
    const video = videos[(index + 1) % videos.length];
    const { data: existingLog, error: logLookupError } = await client
      .from("dispatch_logs")
      .select("id")
      .eq("campaign_id", campaigns[0].id)
      .eq("group_id", group.id)
      .eq("video_id", video.id)
      .maybeSingle();

    if (logLookupError) {
      throw logLookupError;
    }

    if (!existingLog?.id) {
      const { error } = await client
        .from("dispatch_logs")
        .insert({
          campaign_id: campaigns[0].id,
          group_id: group.id,
          video_id: video.id,
          status: index % 2 === 0 ? "enviado" : "falhou",
          mensagem_erro: index % 2 === 0 ? null : "Falha simulada",
        });

      if (error) {
        throw error;
      }
    }
  }

  console.log("Seed executado com sucesso");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
