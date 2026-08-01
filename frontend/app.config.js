module.exports = ({ config }) => {
  const previewBaseUrl = process.env.TIMEFLOW_PREVIEW_BASE_URL?.trim();

  if (!previewBaseUrl) return config;

  return {
    ...config,
    experiments: {
      ...config.experiments,
      baseUrl: previewBaseUrl,
    },
  };
};
