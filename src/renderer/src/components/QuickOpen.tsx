import {observer} from 'mobx-react-lite'
import React, {useCallback, useRef} from 'react'
import {Subject} from 'rxjs'
import {useSubject} from '../hooks/subscribe'
import {IFileItem} from '../types/index'
import { useGetSetState } from 'react-use'
import { useCoreContext } from '../store/core'
import { useTranslation } from 'react-i18next'

export const quickOpen$ = new Subject()
export const QuickOpen = observer(() => {
  const core = useCoreContext()
  const {t} = useTranslation()
  const [state, setState] = useGetSetState({
    records: [] as (IFileItem & {path: string})[],
    filterRecords: [] as (IFileItem & {path: string})[],
    activeIndex: 0,
    open: false,
    query: ''
  })
  const scrollRef = useRef<HTMLDivElement>(null)

  const keydown = useCallback((e: KeyboardEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    const scroll = state().filterRecords.length > 1
    if (['ArrowDown', 'ArrowUp'].includes(e.key) && scroll) {
      if (e.key === 'ArrowDown') {
        const index = state().activeIndex === state().filterRecords.length - 1 ? 0 : state().activeIndex + 1
        setState({activeIndex: index})
      }
      if (e.key === 'ArrowUp') {
        const index = state().activeIndex === 0 ? state().filterRecords.length - 1 : state().activeIndex - 1
        setState({activeIndex: index})
      }
      const target = scrollRef.current!.children[state().activeIndex] as HTMLDivElement
      const {scrollTop, clientHeight} = scrollRef.current!
      if (target.offsetTop > scrollTop + clientHeight - 36) {
        scrollRef.current!.scroll({
          top: target.offsetTop
        })
      }
      if (target.offsetTop < scrollTop) {
        scrollRef.current!.scroll({
          top: target.offsetTop - 30
        })
      }
    }
    if (e.key === 'Enter' && state().filterRecords.length) {
      close()
      const node = core.tree.nodeMap.get(state().filterRecords[state().activeIndex]?.cid)
      if (node) {
        core.tree.openNote(node)
      }
    }
    if (e.key === 'Escape') {
      close()
    }
  }, [])
  useSubject(quickOpen$, async () => {
    if (core.tree.root) {
      const {docs} = core.tree.allNotes
      const filterData = docs.filter((q) => !state().query || q.path.includes(state().query))
      setState({
        records: docs,
        open: true,
        activeIndex: 0,
        filterRecords: filterData
      })
    } else {
      setState({records: [], filterRecords: []})
    }
    window.addEventListener('keydown', keydown)
  })
  const close = useCallback(() => {
    window.removeEventListener('keydown', keydown)
    setState({open: false})
  }, [])

  if (!state().open) return null
  return (
    <div className={'z-[1000] fixed inset-0 dark:bg-black/30 bg-black/10'} onClick={close}>
      <div
        className={'mt-20 w-[600px] ctx-panel rounded-lg mx-auto'}
        onClick={e => e.stopPropagation()}
      >
        <input
          className={'bg-transparent outline-none h-10 w-full px-4 dark:text-gray-200 text-gray-600 dark:placeholder-gray-200/50 placeholder-gray-400'}
          placeholder={'Find recent open note'}
          autoFocus={true}
          value={state().query}
          onKeyDown={keydown}
          onChange={e => {
            const query = e.target.value
            setState({query, filterRecords: state().records.filter(q => q.path.includes(query)), activeIndex: 0})
          }}
        />
        <div className={'h-[1px] bg-gray-200 dark:bg-gray-200/20'}/>
        <div
          className={`p-2 relative overflow-y-auto max-h-[300px] ${!!state().filterRecords.length ? '' : 'hidden'}`}
          ref={scrollRef}>
          {state().filterRecords.map((r, i) =>
            <div
              onMouseEnter={() => {
                setState({activeIndex: i})
              }}
              onClick={() => {
                close()
                core.tree.openNote(core.tree.nodeMap.get(r.cid)!)
              }}
              className={`cursor-default px-3 py-1 rounded dark:text-gray-300 text-gray-600 text-sm ${state().activeIndex === i ? 'dark:bg-gray-200/10 bg-gray-200/60' : ''}`}
              key={r.cid}>
              {r.path}
            </div>
          )}
        </div>
        <div className={`px-4 py-2 ${!state().filterRecords.length ? '' : 'hidden'}`}>
          <div className={'text-gray-500 text-center text-sm'}>{t('noOpendHistory')}</div>
        </div>
      </div>
    </div>
  )
})
