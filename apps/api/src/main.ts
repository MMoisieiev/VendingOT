import 'reflect-metadata';
import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Headers,
  HttpException,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { createTier, saveProduct, saveMachine, machineInput } from './catalog';
import { machineHistory, postRefill } from './machines';
import {
  saveSupplier,
  saveSupplierProduct,
  supplierCostHistory,
} from './suppliers';
import { postReceipt, receiptHistory } from './receiving';
import { devActor, pool } from './db';
import {
  createLocation,
  createProduct,
  locationInput,
  movementInput,
  overview,
  parse,
  postMovement,
  productInput,
  reversalInput,
} from './inventory';

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof HttpException) {
      const detail = error.getResponse();
      response
        .status(error.getStatus())
        .json(typeof detail === 'string' ? { message: detail } : detail);
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      response.status(409).json({
        code: 'DUPLICATE_CODE',
        message:
          'That SKU, serial number, asset code, location code, supplier name, delivery reference or tier name is already in use.',
      });
    } else {
      console.error(error);
      response.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'The operation failed. No partial stock movement was saved.',
      });
    }
  }
}

@Controller('api/v1')
class ApiController {
  @Get('health') async health() {
    await pool.query('SELECT 1');
    return { status: 'ok', mode: 'local-development', authentication: false };
  }
  @Get('overview') overview() {
    return overview(devActor);
  }
  @Post('products') product(@Body() body: unknown) {
    return createProduct(devActor, parse(productInput, body));
  }
  @Post('products/:id') updateProduct(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return saveProduct(devActor, body, parse(z.uuid(), id));
  }
  @Post('price-tiers') tier(@Body() body: unknown) {
    return createTier(devActor, body);
  }
  @Post('suppliers') supplier(@Body() body: unknown) {
    return saveSupplier(devActor, body);
  }
  @Post('suppliers/:id') updateSupplier(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return saveSupplier(devActor, body, parse(z.uuid(), id));
  }
  @Post('supplier-products') supplierProduct(@Body() body: unknown) {
    return saveSupplierProduct(devActor, body);
  }
  @Get('supplier-products/:id/cost-history') costHistory(
    @Param('id') id: string,
  ) {
    return supplierCostHistory(devActor, parse(z.uuid(), id));
  }
  @Post('supplier-receipts') receive(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string = '',
  ) {
    return postReceipt(devActor, key, body);
  }
  @Get('supplier-receipts') receipts() {
    return receiptHistory(devActor);
  }
  @Post('machines') machine(@Body() body: unknown) {
    return saveMachine(devActor, parse(machineInput, body));
  }
  @Post('machines/:id') updateMachine(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return saveMachine(devActor, body, parse(z.uuid(), id));
  }
  @Get('machines/:id/history') history(@Param('id') id: string) {
    return machineHistory(devActor, parse(z.uuid(), id));
  }
  @Post('machines/:id/refills') refill(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string = '',
  ) {
    return postRefill(devActor, parse(z.uuid(), id), key, body);
  }
  @Post('locations') location(@Body() body: unknown) {
    return createLocation(devActor, parse(locationInput, body));
  }
  @Post('stock-documents') movement(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string = '',
  ) {
    return postMovement(devActor, key, parse(movementInput, body));
  }
  @Post('stock-documents/:id/reverse') reverse(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string = '',
  ) {
    return postMovement(devActor, key, {
      reversalOf: parse(z.uuid(), id),
      ...parse(reversalInput, body),
    });
  }
}
@Module({ controllers: [ApiController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new ApiErrors());
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.API_PORT ?? 3001),
    process.env.API_HOST ?? '127.0.0.1',
  );
}
bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
