const fs = require('fs');

module.exports = {
    input: [
        'src/**/*.{js,jsx}',
    ],
    output: './',
    options: {
        debug: true,
        removeUnusedKeys: true,
        sort: true,
        func: {
            list: ['t'],
            extensions: ['.js', '.jsx'],
        },
        lngs: ['en', 'tr'],
        defaultLng: 'en',
        resource: {
            loadPath: 'src/locales/{{lng}}/{{ns}}.json',
            savePath: 'src/locales/{{lng}}/{{ns}}.json',
            jsonIndent: 2,
            lineEnding: '\n',
        },
        nsSeparator: false,
        keySeparator: false,
        interpolation: {
            prefix: '{{',
            suffix: '}}',
        },
    },
};
