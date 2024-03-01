import {IFileItem, ISpaceNode} from '../../index'
import {IMenu, openMenus} from '../Menu'
import React from 'react'
import {treeStore} from '../../store/tree'
import {configStore} from '../../store/config'
import {isMac, message$, nid} from '../../utils'
import {MainApi} from '../../api/main'
import {toMarkdown} from '../../editor/utils/toMarkdown'
import {db, IFile} from '../../store/db'
import {join} from 'path'
import {createFileNode} from '../../store/parserNode'
import {statSync, writeFileSync} from 'fs'
import {runInAction} from 'mobx'
import {EditorUtils} from '../../editor/utils/editorUtils'
import {openEditFolderDialog$} from './EditFolderDialog'

export const createDoc = async (parent?: IFileItem | ISpaceNode, newName = 'Untitled', copyItem?: IFileItem) => {
  const name = getCreateName(parent, newName)
  const id = nid()
  const now = Date.now()
  let target = parent ? join(parent.filePath, name + '.md') : ''
  const md = toMarkdown(copyItem?.schema || [EditorUtils.p])
  writeFileSync(target, md , {encoding: 'utf-8'})
  const s = statSync(target)
  const data:IFile = {
    cid: id,
    filePath: target,
    created: now,
    folder: false,
    updated: s.mtime.valueOf(),
    schema: JSON.parse(JSON.stringify(copyItem?.schema || [EditorUtils.p])),
    sort: 0,
    lastOpenTime: now,
    spaceId: parent ? parent.root ? parent.cid : parent.spaceId : undefined
  }
  await db.file.add(data)
  const newNode = createFileNode(data, parent)
  if (parent) {
    const index = copyItem ? parent!.children!.findIndex(n => n === copyItem) : parent.children!.length - 1
    runInAction(() => {
      parent!.children!.splice(index + 1, 0, newNode)
    })
    parent.children!.map((n, i) => {
      db.file.update(n.cid, {sort: i})
      n.sort = i
    })
  }
  treeStore.openNote(newNode)
  setTimeout(() => {
    treeStore.currentTab.store.container?.querySelector<HTMLInputElement>('.page-title')?.focus()
  }, 30)
}

export const getCreateName = (parent?: IFileItem | ISpaceNode, name = 'Untitled') => {
  if (!parent) return name
  const start = name.match(/\s(\d+)$/)
  let index = start ? +start[1] : 0
  let cur = name
  const stack = parent.children || []
  while (stack.some(s => s.filename === cur)) {
    index++
    cur = name + ' ' + index
  }
  return cur
}
export const openContextMenu = (e: React.MouseEvent, node: IFileItem | ISpaceNode) => {
  runInAction(() => treeStore.selectItem = node.root ? null : node)
  if (!node.root && !node.folder) {
    const isMd = node.ext === 'md'
    const menus: IMenu[] = [
      {
        text: configStore.zh ? '在新标签中打开' : 'Open in New Tab',
        click: () => {
          treeStore.appendTab(node)
        },
        key: 'cmd+click'
      }
    ]
    if (isMd) {
      menus.push(...[
        {
          text: configStore.zh ? '新副本' : 'New Copy',
          click: async () => {
            createDoc(node.parent!, node.filename, node)
          }
        },
        {hr: true},
        {
          text: configStore.zh ? '复制Markdown代码' : 'Copy Markdown Source Code',
          click: () => {
            const md = toMarkdown(node.schema || [])
            window.api.copyToClipboard(md)
            message$.next({
              type: 'success',
              content: configStore.zh ? '已复制到剪贴板' : 'Copied to clipboard'
            })
          }
        }
      ])
    }
    menus.push(...[
      {
        text: configStore.zh ? isMac ? '在Finder中显示' : '在File Explorer中显示' : isMac ? 'Reveal in Finder' : 'Reveal in File Explorer',
        click: () => MainApi.openInFolder(node.filePath)
      },
      {hr: true},
      {
        text: configStore.zh ? '移到废纸篓' : 'Move to Trash',
        click: () => treeStore.moveToTrash(node),
        key: 'cmd+backspace'
      }
    ])
    openMenus(e, menus)
  } else {
    const menus:IMenu[] = [
      {
        text: configStore.zh ? '新建文档' : 'New Doc',
        click: () => {
          createDoc(node)
        }
      },
      {
        text: configStore.zh ? '新建文件夹' : 'New Folder',
        click: () => {
          openEditFolderDialog$.next({
            ctxNode: node.root ? undefined : node,
            mode: 'create'
          })
        }
      },
    ]
    if (!node.root) {
      menus.push({
        text: configStore.zh ? '重命名' : 'Rename',
        click: () => {
          openEditFolderDialog$.next({
            ctxNode: node,
            mode: 'update'
          })
        }
      })
    }
    menus.push(...[
      {hr: true},
      {
        text: configStore.zh ? isMac ? '在Finder中显示' : '在File Explorer中显示' : isMac ? 'Reveal in Finder' : 'Reveal in File Explorer',
        click: () => MainApi.openInFolder(node.filePath)
      },
      {
        text: configStore.zh ? '分享文件夹' : 'Share Folder',
      }
    ])
    if (!node.root) {
      menus.push(...[
        {hr: true},
        {
          text: configStore.zh ? '移到废纸篓' : 'Move to Trash',
          click: () => treeStore.moveToTrash(node),
          key: 'cmd+backspace'
        }
      ])
    }
    openMenus(e, menus)
  }
}