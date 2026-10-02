import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import '@fontsource/jetbrains-mono/500.css'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

export default mount(App, { target: document.getElementById('app')! })
