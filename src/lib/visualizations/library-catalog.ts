/** Fixed, reviewed classic-script builds. URLs never come from a network discovery call. */
export const VISUALIZATION_LIBRARIES = [
  { id: 'd3', name: 'D3', version: '7.9.0', bundled: true, bytes: 279706,
    url: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
    sha256: 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539', license: 'ISC' },
  { id: 'chartjs', name: 'Chart.js', version: '4.5.1', bundled: false, bytes: 208522,
    url: 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js',
    sha256: '48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a', license: 'MIT' },
  { id: 'echarts', name: 'ECharts', version: '6.1.0', bundled: false, bytes: 1121883,
    url: 'https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js',
    sha256: 'b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0', license: 'Apache-2.0' },
] as const;

export type VisualizationLibrary = typeof VISUALIZATION_LIBRARIES[number];
