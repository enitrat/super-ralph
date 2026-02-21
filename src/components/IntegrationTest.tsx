import { Parallel, Task } from "smithers-orchestrator";
import IntegrationTestPrompt from "../prompts/IntegrationTest.mdx";

type IntegrationTestProps = {
  categories: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  outputs: any;
  agent: any;
  fallbackAgent: any;
  taskRetries: number;
  maxConcurrency: number;
  categoryTestSuites: Record<string, {
    suites: string[];
    setupHints: string[];
    testDirs: string[];
  }>;
  findingsFile: string;
};

export function IntegrationTest({
  categories,
  outputs,
  agent,
  fallbackAgent,
  taskRetries,
  maxConcurrency,
  categoryTestSuites,
  findingsFile,
}: IntegrationTestProps) {
  return (
    <Parallel maxConcurrency={maxConcurrency}>
      {categories.map(({ id, name }) => {
        const suiteInfo = categoryTestSuites[id] ?? { suites: [], setupHints: [], testDirs: [] };
        return (
          <Task
            key={id}
            id={`integration-test:${id}`}
            output={outputs.integration_test}
            agent={agent}
            fallbackAgent={fallbackAgent}
            retries={taskRetries}
          >
            <IntegrationTestPrompt
              categoryId={id}
              categoryName={name}
              suites={suiteInfo.suites}
              setupHints={suiteInfo.setupHints}
              testDirs={suiteInfo.testDirs}
              findingsFile={findingsFile}
            />
          </Task>
        );
      })}
    </Parallel>
  );
}
