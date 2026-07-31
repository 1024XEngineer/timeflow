# TimeFlow

## Frontend map setup

Copy `frontend/.env.example` to `frontend/.env` and set
`EXPO_PUBLIC_BAIDU_MAP_AK` to a Baidu Maps browser-side AK. Enable JavaScript
API v4 for that AK in the Baidu Maps console and add the development and
production web origins to its Referer whitelist. Native builds render the
same JavaScript API in a WebView, so its configured `baseUrl`
(`https://timeflow.local/`) must also be allowed by the AK configuration.
