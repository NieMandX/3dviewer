const YC_BUCKET_BASE_URL = 'https://storage.yandexcloud.net/maragojeep';

export const SAMPLE_MODELS = [
    { label: 'Примеры моделей', files: [] },
    {
        label: 'SH35_LPM',
        files: [
            `${YC_BUCKET_BASE_URL}/0610_Shabolovka_Vl_35.zip`,
        ]
    },
    {
        label: 'SH34_LPM',
        files: [
            `${YC_BUCKET_BASE_URL}/0610_Shabolovka_Vl_34.zip`,
        ]
    },
    {
        label: 'SH35_HPM',
        files: [
            `${YC_BUCKET_BASE_URL}/SM_Shabolovka_Vl_35.zip`,
            `${YC_BUCKET_BASE_URL}/SM_Shabolovka_Vl_35_Ground.zip`,
        ]
    },
    {
        label: 'SH34_HPM',
        files: [
            `${YC_BUCKET_BASE_URL}/SM_Shabolovka_Vl_34.zip`,
            `${YC_BUCKET_BASE_URL}/SM_Shabolovka_Vl_34_Ground.zip`,
        ]
    }
];
