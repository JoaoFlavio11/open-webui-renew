export const mockBackendConfig = {
    status: true,
    name: 'Open WebUI Dev',
    version: '0.0.0-dev',
    default_locale: 'pt-br',
};

export const isMockMode = () => import.meta.env.DEV;