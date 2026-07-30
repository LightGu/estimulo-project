function formatDayLabel(date = new Date(), timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone || process.env.CAMPAIGN_TIMEZONE || process.env.TZ || "America/Bahia",
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return `${parts.day}/${parts.month}`;
}

function formatDateOnlyInTimezone(date = new Date(), timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: timezone || process.env.CAMPAIGN_TIMEZONE || process.env.TZ || "America/Bahia",
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatCampaignDayName(date = new Date(), timezone) {
  return `Campanha do dia ${formatDayLabel(date, timezone)}`;
}

function formatAdHocCampaignName(date = new Date(), timezone) {
  return `Campanha de texto do dia ${formatDayLabel(date, timezone)}`;
}

module.exports = {
  formatAdHocCampaignName,
  formatCampaignDayName,
  formatDateOnlyInTimezone,
  formatDayLabel,
};
