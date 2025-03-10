import { action, makeAutoObservable, runInAction } from 'mobx'
import {
  BaseSelection,
  createEditor,
  Editor,
  Element,
  Node,
  NodeEntry,
  Path,
  Range,
  Transforms,
  Selection,
  BaseRange
} from 'slate'
import { ReactEditor, withReact } from 'slate-react'
import { GetFields } from '../types/index'
import React, { createContext, useContext } from 'react'
import { MediaNode, TableCellNode } from '../types/el'
import { Subject } from 'rxjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'fs'
import { basename, isAbsolute, join, parse, relative, sep } from 'path'
import { getOffsetLeft, getOffsetTop, mediaType, slugify } from './utils/dom'
import { MainApi } from '../api/main'
import { withMarkdown } from './plugins'
import { withHistory } from 'slate-history'
import { withErrorReporting } from './plugins/catchError'
import { getImageData, nid } from '../utils'
import { openMenus } from '../components/Menu'
import { EditorUtils } from './utils/editorUtils'
import { toUnixPath } from '../utils/path'
import { selChange$ } from './plugins/useOnchange'
import { Core } from '../store/core'
import { Ace, Range as AceRange } from 'ace-builds'
import { db, IFile } from '../store/db'

export const EditorStoreContext = createContext<EditorStore | null>(null)
export const useEditorStore = () => {
  return useContext(EditorStoreContext)!
}

export class EditorStore {
  editor = withMarkdown(withReact(withHistory(createEditor())), this)
  // Manually perform editor operations
  manual = false
  codes = new WeakMap<object, Ace.Editor>()
  openInsertNetworkImage = false
  webview = false
  initializing = false
  clearTimer = 0
  sel: BaseSelection | undefined
  focus = false
  readonly = false
  private ableToEnter = new Set([
    'paragraph',
    'head',
    'blockquote',
    'code',
    'table',
    'list',
    'media',
    'attach'
  ])
  dragEl: null | HTMLElement = null
  openSearch = false
  focusSearch = false
  docChanged = false
  startDragging = false
  search = {
    text: '',
    currentIndex: 0
  }
  searchRanges: {
    range?: BaseRange
    markerId?: number
    aceRange?: InstanceType<typeof AceRange>
    editor?: Ace.Editor
  }[] = []
  openInsertCompletion = false
  insertCompletionText$ = new Subject<string>()
  highlightCache = new Map<object, Range[]>()
  private searchTimer = 0
  refreshFloatBar = false
  refreshTableAttr = false
  openLangCompletion = false
  langCompletionText = new Subject<string>()
  quickLinkText$ = new Subject<string | undefined>()
  openQuickLinkComplete = false
  floatBar$ = new Subject<string>()
  mediaNode$ = new Subject<NodeEntry<MediaNode> | null>()
  openInsertLink$ = new Subject<Selection>()
  openLinkPanel = false
  scrolling = false
  tableCellNode: null | NodeEntry<TableCellNode> = null
  refreshHighlight = false
  domRect: DOMRect | null = null
  container: null | HTMLDivElement = null
  history = false
  inputComposition = false
  openFilePath: string | null = null
  webviewFilePath: string | null = null
  saveDoc$ = new Subject<any[] | null>()
  tableTask$ = new Subject<string>()
  docChanged$ = new Subject<boolean>()
  viewImages: string[] = []
  viewImageIndex = 0
  openViewImage = false
  get doc() {
    return this.container?.querySelector('.content') as HTMLDivElement
  }

  doManual() {
    this.manual = true
    setTimeout(() => (this.manual = false), 30)
  }

  constructor(
    private readonly core: Core,
    webview = false,
    history = false
  ) {
    this.webview = webview
    this.history = history
    this.dragStart = this.dragStart.bind(this)
    withErrorReporting(this.editor)
    makeAutoObservable(this, {
      searchRanges: false,
      editor: false,
      tableCellNode: false,
      inputComposition: false,
      scrolling: false,
      openFilePath: false,
      container: false,
      highlightCache: false,
      dragEl: false,
      manual: false,
      openLinkPanel: false,
      initializing: false,
      clearTimer: false,
      codes: false
    })
  }
  clearCodeCache(node: any) {
    clearTimeout(this.clearTimer)
    this.clearTimer = window.setTimeout(() => {
      runInAction(() => {
        this.refreshHighlight = !this.refreshHighlight
      })
    }, 60)
  }
  openPreviewImages(el: MediaNode) {
    const nodes = Array.from(
      Editor.nodes<MediaNode>(this.editor, {
        at: [],
        match: (n) => n.type === 'media' && n.mediaType === 'image'
      })
    )
    let index = nodes.findIndex((n) => n[0] === el)
    if (index < 0) {
      index = 0
    }
    if (nodes.length) {
      this.viewImageIndex = index
      this.viewImages = nodes
        .map((n) => {
          let realUrl = n[0].url
          if (realUrl && !realUrl?.startsWith('http') && !realUrl.startsWith('file:')) {
            const file = isAbsolute(realUrl)
              ? n[0].url
              : join(this.openFilePath || '', '..', realUrl)
            const data = getImageData(file)
            if (data) {
              realUrl = data
            }
          }
          return realUrl!
        })
        .filter((url) => (!/^\w+:/.test(url) && existsSync(url)) || /^\w+:/.test(url))
      if ((this, this.viewImages.length)) {
        this.openViewImage = true
      }
    }
  }
  hideRanges() {
    if (this.highlightCache.size) {
      setTimeout(() => {
        runInAction(() => {
          this.highlightCache.clear()
          this.refreshHighlight = !this.refreshHighlight
        })
      }, 60)
    }
  }

  offsetTop(node: HTMLElement) {
    let top = this.openSearch ? 46 : 0
    const doc = this.doc
    while (doc?.contains(node.offsetParent) && doc !== node) {
      top += node.offsetTop
      node = node.offsetParent as HTMLElement
    }
    return top
  }

  offsetLeft(node: HTMLElement) {
    let left = 0
    const doc = this.doc
    while (doc.contains(node) && doc !== node) {
      left += node.offsetLeft
      node = node.offsetParent as HTMLElement
    }
    return left
  }

  doRefreshHighlight() {
    setTimeout(
      action(() => {
        this.refreshHighlight = !this.refreshHighlight
      }),
      60
    )
  }

  matchSearch(scroll: boolean = true) {
    this.highlightCache.clear()
    this.searchRanges = []
    if (!this.search.text) {
      if (this.searchRanges) {
        for (const item of this.searchRanges) {
          if (item.editor) {
            EditorUtils.clearAceMarkers(item.editor)
          }
        }
      }
      this.search.currentIndex = 0
      this.refreshHighlight = !this.refreshHighlight
      return
    }
    const nodes = Array.from(
      Editor.nodes<any>(this.editor, {
        at: [],
        match: (n) =>
          Element.isElement(n) && ['paragraph', 'table-cell', 'code', 'head'].includes(n.type)
      })
    )
    let matchCount = 0
    const keyWord = this.search.text.toLowerCase()
    let allRanges: typeof this.searchRanges = []
    for (let n of nodes) {
      const [el, path] = n
      if (el.type === 'code') {
        const editor = this.codes.get(el)
        if (editor) {
          EditorUtils.clearAceMarkers(editor)
          const documentText = editor.session.getDocument().getValue()
          const lines = documentText.split('\n')
          const regex = new RegExp(keyWord, 'g')
          for (let i = 0; i < lines.length; i++) {
            const item = lines[i]
            const match = item.matchAll(regex)
            for (const m of match) {
              const range = new AceRange(i, m.index!, i, m.index! + m[0].length)
              const data: (typeof this.searchRanges)[number] = {
                aceRange: range,
                editor: editor
              }
              const markerId = editor.session.addMarker(
                range,
                matchCount === this.search.currentIndex ? 'match-current' : 'match-text',
                'text',
                false
              )
              data.markerId = markerId
              allRanges.push(data)
              matchCount++
            }
          }
        }
      } else {
        const str = Node.string(el).toLowerCase()
        if (!str || /^\s+$/.test(str) || !str.includes(keyWord)) {
          continue
        }
        let ranges: typeof this.searchRanges = []
        for (let i = 0; i < el.children.length; i++) {
          const text = el.children[i].text?.toLowerCase()
          if (text && text.includes(keyWord)) {
            const sep = text.split(keyWord)
            let offset = 0
            for (let j = 0; j < sep.length; j++) {
              if (j === 0) {
                offset += sep[j].length
                continue
              }
              ranges.push({
                range: {
                  anchor: {
                    path: [...path, i],
                    offset: offset
                  },
                  focus: {
                    path: [...path, i],
                    offset: offset + keyWord.length
                  },
                  current: matchCount === this.search.currentIndex,
                  highlight: true
                }
              })
              offset += sep[j].length + keyWord.length
              matchCount++
            }
          }
        }
        allRanges.push(...ranges)
        this.highlightCache.set(
          el,
          ranges.map((r) => r.range!)
        )
      }
    }
    if (this.search.currentIndex > matchCount - 1) {
      this.search.currentIndex = 0
    }
    this.searchRanges = allRanges
    this.refreshHighlight = !this.refreshHighlight
    if (scroll) requestIdleCallback(() => this.toPoint())
  }

  setOpenSearch(open: boolean) {
    this.openSearch = open
    this.domRect = null
    if (!open) {
      this.highlightCache.clear()
      this.searchRanges = []
      this.refreshHighlight = !this.refreshHighlight
    } else {
      this.focusSearch = !this.focusSearch
      if (this.search.text) {
        this.matchSearch()
        this.toPoint()
      }
    }
  }

  setSearchText(text?: string) {
    this.searchRanges = []
    this.search.currentIndex = 0
    this.search.text = text || ''
    clearTimeout(this.searchTimer)
    this.searchTimer = window.setTimeout(() => {
      this.matchSearch()
    }, 300)
  }

  private changeCurrent() {
    const codes = new Set<Ace.Editor>()
    this.searchRanges.forEach(
      action((r, j) => {
        if (r.range) {
          r.range.current = j === this.search.currentIndex
        } else if (r.editor) {
          codes.add(r.editor)
          const marker = r.editor.session.getMarkers()[r.markerId!]
          const cl = j === this.search.currentIndex ? 'match-current' : 'match-text'
          if (marker && cl !== marker.clazz) {
            r.editor.session.removeMarker(r.markerId!)
            const id = r.editor.session.addMarker(marker.range!, cl, 'text', false)
            r.markerId = id
          }
        }
      })
    )
    this.refreshHighlight = !this.refreshHighlight
  }

  nextSearch() {
    if (this.search.currentIndex === this.searchRanges.length - 1) {
      this.search.currentIndex = 0
    } else {
      this.search.currentIndex++
    }
    this.changeCurrent()
    this.toPoint()
  }

  prevSearch() {
    if (this.search.currentIndex === 0) {
      this.search.currentIndex = this.searchRanges.length - 1
    } else {
      this.search.currentIndex--
    }
    this.changeCurrent()
    this.toPoint()
  }

  setState<T extends GetFields<EditorStore>>(value: (state: EditorStore) => void) {
    if (value instanceof Function) {
      value(this)
    } else {
      for (let key of Object.keys(value)) {
        this[key] = value[key]
      }
    }
  }

  async insertMultipleFiles(files: File[]) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const path = EditorUtils.findMediaInsertPath(this.editor)
    if (path && imageFiles.length) {
      const paths: string[] = []
      for (let f of imageFiles) {
        if (f.path) {
          const imgDir = await this.getImageDir()
          const name = nid() + parse(f.path).ext
          const copyPath = join(imgDir, name)
          cpSync(f.path, copyPath)
          if (this.core.tree.root && this.core.tree.openedNote) {
            paths.push(
              toUnixPath(relative(join(this.core.tree.openedNote.filePath, '..'), copyPath))
            )
          } else {
            paths.push(copyPath)
          }

          if (this.core.tree.root) {
            this.core.node.insertFileNode({
              filePath: copyPath,
              folder: false,
              spaceId: this.core.tree.root?.cid
            })
          }
        } else {
          const path = await this.saveFile(f)
          paths.push(path)
          if (this.core.tree.root) {
            this.core.node.insertFileNode({
              filePath: path,
              folder: false,
              spaceId: this.core.tree.root?.cid
            })
          }
        }
      }
      Transforms.insertNodes(
        this.editor,
        paths.map((p) => {
          return { type: 'media', url: p, children: [{ text: '' }] }
        }),
        { select: true, at: path }
      )
    }
  }

  private async createDir(path: string) {
    try {
      if (!this.core.tree.root) return
      let rootPath = this.core.tree.root.filePath
      const stack = path.replace(rootPath, '').split(sep).slice(1)
      while (stack.length) {
        const name = stack.shift()!
        const curPath = join(rootPath, name)
        if (!existsSync(curPath)) {
          mkdirSync(curPath)
        }
        rootPath = curPath
      }
    } catch (e) {
      console.error('create dir', e)
    }
  }
  async getImageDir() {
    if (this.core.tree.root) {
      let path = this.core.tree.root.savePath || '.images'
      path = path
        .split('/')
        .map((p) =>
          p.replace(
            /\[docName\]/gi,
            basename(this.core.tree.openedNote!.filePath).replace(/\.(md|markdown)$/, '')
          )
        )
        .join('/')

      const dir =
        this.core.tree.root.saveFolder !== 'docWorkspaceFolder'
          ? join(this.core.tree.openedNote!.filePath, '..', path)
          : join(this.core.tree.root.filePath, path)
      if (!existsSync(dir)) {
        await window.api.fs.mkdir(dir, { recursive: true })
        let p = dir
        const nodeMap = new Map(Array.from(this.core.tree.nodeMap).map(n => [n[1].filePath, n[1]]))
        const stack = p.replace(this.core.tree.root.filePath + sep, '').split(sep)
        let curPath = this.core.tree.root.filePath
        while(stack.length) {
          const name = stack.shift()!
          curPath = join(curPath, name)
          if (!nodeMap.get(curPath)) {
            const id = nid()
            const now = Date.now()
            const data: IFile = {
              cid: id,
              filePath: curPath,
              spaceId: this.core.tree.root!.cid,
              updated: now,
              sort: 0,
              folder: true,
              created: now
            }
            await db.file.add(data)
            const parent = nodeMap.get(join(curPath, '..')) || this.core.tree.root!
            if (parent) {
              runInAction(() => {
                const node = this.core.node.createFileNode(data, parent)
                parent.children?.unshift(node)
                parent.children?.map((s, i) => {
                  db.file.update(s.cid, { sort: i })
                })
                this.core.tree.nodeMap.set(node.cid, node)
                nodeMap.set(node.filePath, node)
              })
            }
          }
        }
      }
      return dir
    } else {
      const path = await MainApi.getCachePath()
      const imageDir = join(path, 'assets')
      if (!existsSync(imageDir)) mkdirSync(imageDir)
      return imageDir
    }
  }
  async saveFile(file: File | { name: string; buffer: ArrayBuffer }) {
    if (this.core.imageBed.route) {
      const p = parse(file.name)
      const name = nid() + p.ext
      const res = await this.core.imageBed.uploadFile([
        { name, data: file instanceof File ? await file.arrayBuffer() : file.buffer }
      ])
      if (res) {
        return res[0]
      }
      return ''
    } else {
      const imgDir = await this.getImageDir()
      let targetPath = ''
      let mediaUrl = ''
      const buffer = file instanceof File ? await file.arrayBuffer() : file.buffer
      const p = parse(file.name)
      const base = file instanceof File ? nid() + p.ext : file.name
      if (this.core.tree.root) {
        targetPath = join(imgDir, base)
        mediaUrl = toUnixPath(
          relative(
            join(this.core.tree.currentTab.current?.filePath || '', '..'),
            join(imgDir, base)
          )
        )
      } else {
        targetPath = join(imgDir, base)
        mediaUrl = targetPath
      }
      writeFileSync(targetPath, new DataView(buffer))
      if (this.core.tree.root && targetPath.startsWith(this.core.tree.root.filePath)) {
        await this.core.node.insertFileNode({
          filePath: targetPath,
          folder: false,
          spaceId: this.core.tree.root?.cid
        })
      }
      return toUnixPath(mediaUrl)
    }
  }

  async insertFiles(files: string[]) {
    const path = EditorUtils.findMediaInsertPath(this.editor)
    files = files.filter((f) => ['image', 'video'].includes(mediaType(f)))
    if (!this.core.tree.openedNote || !path || !files.length) return
    if (this.core.imageBed.route) {
      const urls = await this.core.imageBed.uploadFile(
        files.map((f) => {
          const p = parse(f)
          const name = nid() + p.ext
          return { data: readFileSync(f).buffer as ArrayBuffer, name }
        })
      )
      if (urls) {
        Transforms.insertNodes(
          this.editor,
          urls.map((url) => {
            return { type: 'media', url: url, children: [{ text: '' }] }
          }),
          { at: path, select: true }
        )
      }
    } else {
      const imgDir = await this.getImageDir()
      const insertPaths: string[] = []
      for (let f of files) {
        const name = nid() + parse(f).ext
        const copyPath = join(imgDir, name)
        cpSync(f, copyPath)
        if (this.core.tree.root) {
          this.core.node.insertFileNode({
            filePath: copyPath,
            folder: false,
            spaceId: this.core.tree.root.cid
          })
          insertPaths.push(
            toUnixPath(relative(join(this.core.tree.openedNote.filePath, '..'), copyPath))
          )
        } else {
          insertPaths.push(copyPath)
        }
      }
      Transforms.insertNodes(
        this.editor,
        insertPaths.map((p) => {
          return { type: 'media', url: p, children: [{ text: '' }] }
        }),
        { at: path, select: true }
      )
    }
    const next = Editor.next(this.editor, { at: path })
    if (next?.[0].type === 'paragraph' && !Node.string(next[0])) {
      Transforms.delete(this.editor, { at: next[1] })
    }
    const [node] = Editor.nodes(this.editor, {
      match: (n) => !!n.type,
      mode: 'lowest'
    })
    selChange$.next({ node, sel: this.editor.selection })
  }

  insertLink(filePath: string) {
    const p = parse(filePath)
    const insertPath =
      this.core.tree.root &&
      isAbsolute(filePath) &&
      filePath.startsWith(this.core.tree.root.filePath)
        ? toUnixPath(relative(join(this.core.tree.openedNote!.filePath, '..'), filePath))
        : filePath
    let node = { text: filePath.startsWith('http') ? filePath : p.name, url: insertPath }
    const sel = this.editor.selection
    if (!sel || !Range.isCollapsed(sel)) return
    const [cur] = Editor.nodes<any>(this.editor, {
      match: (n) => Element.isElement(n),
      mode: 'lowest'
    })
    if (node.text && ['table-cell', 'paragraph'].includes(cur[0].type)) {
      Transforms.insertNodes(this.editor, node, { select: true })
    } else {
      const [par] = Editor.nodes<any>(this.editor, {
        match: (n) => Element.isElement(n) && ['table', 'code', 'head'].includes(n.type)
      })
      Transforms.insertNodes(
        this.editor,
        {
          type: 'paragraph',
          children: [node]
        },
        { select: true, at: Path.next(par[1]) }
      )
    }
  }
  openTableMenus(e: MouseEvent | React.MouseEvent, head?: boolean) {
    openMenus(e, [
      {
        text: 'Add Row Above',
        click: () => this.tableTask$.next('insertRowBefore')
      },
      {
        text: 'Add Row Below',
        key: 'cmd+shift+enter',
        click: () => this.tableTask$.next('insertRowAfter')
      },
      { hr: true },
      {
        text: 'Add Column Before',
        click: () => this.tableTask$.next('insertColBefore')
      },
      {
        text: 'Add Column After',
        click: () => this.tableTask$.next('insertColAfter')
      },
      { hr: true },
      {
        text: 'Line break within table-cell',
        key: 'cmd+enter',
        click: () => this.tableTask$.next('insertTableCellBreak')
      },
      {
        text: 'Move',
        children: [
          {
            text: 'Move Up One Row',
            disabled: head,
            click: () => this.tableTask$.next('moveUpOneRow')
          },
          {
            text: 'Move Down One Row',
            disabled: head,
            click: () => this.tableTask$.next('moveDownOneRow')
          },
          {
            text: 'Move Left One Col',
            click: () => this.tableTask$.next('moveLeftOneCol')
          },
          {
            text: 'Move Right One Col',
            click: () => this.tableTask$.next('moveRightOneCol')
          }
        ]
      },
      { hr: true },
      {
        text: 'Delete Col',
        key: 'cmd+option+backspace',
        click: () => this.tableTask$.next('removeCol')
      },
      {
        text: 'Delete Row',
        key: 'cmd+shift+backspace',
        click: () => this.tableTask$.next('removeRow')
      }
    ])
  }
  private toPoint() {
    try {
      const cur = this.searchRanges[this.search.currentIndex]
      if (!cur) return
      let dom: null | HTMLElement = null
      if (cur.range) {
        const node = Node.get(this.editor, Path.parent(cur.range.focus.path))
        dom = ReactEditor.toDOMNode(this.editor, node)
      } else if (cur.editor && cur.aceRange) {
        const lines = cur.editor.container.querySelectorAll('.ace_line')
        dom = lines[cur.aceRange.start.row] as HTMLElement
      }
      if (dom) {
        const top = getOffsetTop(dom, this.container!) - 80
        if (
          top > this.container!.scrollTop + 40 &&
          top < this.container!.scrollTop + (window.innerHeight - 120)
        )
          return
        this.container!.scroll({
          top: top - 100
        })
      }
    } catch (e) {
      console.error('toPoint', e)
    }
  }

  private toPath(el: HTMLElement) {
    const node = ReactEditor.toSlateNode(this.editor, el)
    const path = ReactEditor.findPath(this.editor, node)
    return [path, node] as [Path, Node]
  }

  dragStart(e: React.MouseEvent) {
    e.stopPropagation()
    this.readonly = true
    type MovePoint = {
      el: HTMLDivElement
      direction: 'top' | 'bottom'
      top: number
      left: number
    }
    const ableToEnter =
      this.dragEl?.dataset?.be === 'list-item'
        ? new Set([
            'paragraph',
            'head',
            'blockquote',
            'code',
            'table',
            'list',
            'list-item',
            'media',
            'attach'
          ])
        : this.ableToEnter
    let mark: null | HTMLDivElement = null
    const els = document.querySelectorAll<HTMLDivElement>('[data-be]')
    const points: MovePoint[] = []
    for (let el of els) {
      if (!ableToEnter.has(el.dataset.be!)) continue
      if (el.classList.contains('frontmatter')) continue
      const pre = el.previousSibling as HTMLElement
      if (
        el.dataset.be === 'paragraph' &&
        this.dragEl?.dataset.be === 'list-item' &&
        (!pre || pre.classList.contains('check-item'))
      ) {
        continue
      }
      if (el === this.dragEl) continue
      if (
        this.dragEl?.tagName.toLowerCase().startsWith('h') &&
        !el.parentElement?.getAttribute('data-slate-editor')
      ) {
        continue
      }
      const top = getOffsetTop(el, this.container!)
      const left = getOffsetLeft(el, this.container!)
      points.push({
        el: el,
        direction: 'top',
        left: el.dataset.be === 'list-item' && !el.classList.contains('task') ? left - 16 : left,
        top: top - 2
      })
      points.push({
        el: el,
        left: el.dataset.be === 'list-item' && !el.classList.contains('task') ? left - 16 : left,
        direction: 'bottom',
        top: top + el.clientHeight + 2
      })
    }
    this.startDragging = true
    let last: MovePoint | null = null
    const dragover = (e: MouseEvent) => {
      e.preventDefault()
      if ((e.clientY > window.innerHeight - 30 || e.clientY < 70) && !this.scrolling) {
        this.container?.scrollBy({ top: e.clientY < 70 ? -400 : 400, behavior: 'smooth' })
        this.scrolling = true
        setTimeout(() => {
          this.scrolling = false
        }, 200)
      }
      const top = e.clientY - 40 + this.container!.scrollTop
      let distance = 1000000
      let cur: MovePoint | null = null
      for (let p of points) {
        let curDistance = Math.abs(p.top - top)
        if (curDistance < distance) {
          cur = p
          distance = curDistance
        }
      }
      if (cur) {
        last = cur
        const width =
          last.el.dataset.be === 'list-item'
            ? last.el.clientWidth + 20 + 'px'
            : last.el.clientWidth + 'px'
        if (!mark) {
          mark = document.createElement('div')
          mark.classList.add('move-mark')
          mark.style.width = width
          mark.style.transform = `translate(${last.left}px, ${last.top}px)`
          this.container!.append(mark)
        } else {
          mark.style.width = width
          mark.style.transform = `translate(${last.left}px, ${last.top}px)`
        }
      }
    }
    window.addEventListener('mousemove', dragover)
    window.addEventListener(
      'mouseup',
      action(() => {
        window.removeEventListener('mousemove', dragover)
        this.readonly = false
        runInAction(() => {
          this.startDragging = false
        })
        if (mark) this.container!.removeChild(mark)
        if (last && this.dragEl) {
          let [dragPath, dragNode] = this.toPath(this.dragEl)
          let [targetPath] = this.toPath(last.el)
          let toPath = last.direction === 'top' ? targetPath : Path.next(targetPath)
          if (!Path.equals(targetPath, dragPath)) {
            const parent = Node.parent(this.editor, dragPath)
            if (dragNode.type === 'table') {
              setTimeout(
                action(() => {
                  this.core.tree.size = JSON.parse(JSON.stringify(this.core.tree.size))
                })
              )
            }
            if (
              Path.equals(Path.parent(targetPath), Path.parent(dragPath)) &&
              Path.compare(dragPath, targetPath) === -1
            ) {
              toPath = Path.previous(toPath)
            }
            let delPath = Path.parent(dragPath)
            const targetNode = Node.get(this.editor, targetPath)
            if (dragNode.type === 'list-item') {
              if (targetNode.type !== 'list-item') {
                Transforms.delete(this.editor, { at: dragPath })
                Transforms.insertNodes(
                  this.editor,
                  {
                    ...parent,
                    children: [EditorUtils.copy(dragNode)]
                  },
                  { at: toPath, select: true }
                )
                if (parent.children?.length === 1) {
                  if (EditorUtils.isNextPath(Path.parent(dragPath), targetPath)) {
                    delPath = Path.next(Path.parent(dragPath))
                  } else {
                    delPath = Path.parent(dragPath)
                  }
                }
              } else {
                Transforms.moveNodes(this.editor, {
                  at: dragPath,
                  to: toPath
                })
              }
            } else {
              Transforms.moveNodes(this.editor, {
                at: dragPath,
                to: toPath
              })
            }
            if (parent.children?.length === 1) {
              if (
                Path.equals(Path.parent(toPath), Path.parent(delPath)) &&
                Path.compare(toPath, delPath) !== 1
              ) {
                delPath = Path.next(delPath)
              }
              Transforms.delete(this.editor, { at: delPath })
            }
          }
          if (dragNode?.type !== 'media') this.dragEl!.draggable = false
        }
        this.dragEl = null
      }),
      { once: true }
    )
  }
  toHash(hash: string) {
    const dom = this.container?.querySelector(
      `[data-head="${slugify(hash.toLowerCase())}"]`
    ) as HTMLElement
    if (dom) {
      this.container?.scroll({
        top: dom.offsetTop + 100,
        behavior: 'smooth'
      })
    }
  }
}
