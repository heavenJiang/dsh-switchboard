/** Stylesheets are bundled as text and injected by the plugin. */
declare module '*.css' {
  const text: string
  export default text
}
